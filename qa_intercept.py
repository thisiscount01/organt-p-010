"""JS 인터셉트로 WS 메시지 캡처 — 실제 게임 QA 검증"""
from playwright.sync_api import sync_playwright
import json, time, math

LOCAL = "http://localhost:3000"

# WS 인터셉트 스크립트 — 페이지 로드 전 삽입
WS_INTERCEPT = """
window.__wsLog = [];
window.__wsSent = [];
const _OrigWS = window.WebSocket;
window.WebSocket = function(...args) {
    const ws = new _OrigWS(...args);
    ws.addEventListener('message', (e) => {
        try { window.__wsLog.push(JSON.parse(e.data)); } catch {}
    });
    const origSend = ws.send.bind(ws);
    ws.send = function(data) {
        try { window.__wsSent.push(JSON.parse(data)); } catch {}
        return origSend(data);
    };
    return ws;
};
"""

def get_ws_events(page):
    try:
        return page.evaluate("window.__wsLog || []")
    except:
        return []

def get_ws_sent(page):
    try:
        return page.evaluate("window.__wsSent || []")
    except:
        return []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    ctx = browser.new_context(viewport={"width":1280,"height":800})
    ctx.add_init_script(WS_INTERCEPT)
    page = ctx.new_page()

    logs = []
    page.on("console", lambda m: logs.append(f"[{m.type}] {m.text[:300]}"))

    # ── 1. 로드 ─────────────────────────────────────────────────────────────────
    print("=== [1] 페이지 로드 ===")
    t0 = time.time()
    page.goto(LOCAL, timeout=10000, wait_until="domcontentloaded")
    load_ms = round((time.time()-t0)*1000)
    print(f"로드: {load_ms}ms")
    page.wait_for_timeout(2500)

    canvas = page.query_selector("canvas")
    print(f"캔버스: {'있음' if canvas else '없음'}")

    # ── 2. 방 만들기 ─────────────────────────────────────────────────────────────
    print("\n=== [2] 방 만들기 ===")
    create_btn = page.query_selector("button:has-text('방 만들기')")
    if create_btn:
        create_btn.click()
        page.wait_for_timeout(2000)
        print("클릭 완료")
    else:
        vis = [b.inner_text().strip() for b in page.query_selector_all("button") if b.is_visible()]
        print(f"버튼 없음: {vis}")

    # WS 이벤트 확인 (방 생성 응답)
    evs = get_ws_events(page)
    print(f"WS 이벤트 (방 생성 후): {[e.get('type') for e in evs[-5:]]}")

    page.screenshot(path="/tmp/qa_ic_01_room.png")

    # ── 3. 게임 시작 ─────────────────────────────────────────────────────────────
    print("\n=== [3] 게임 시작 ===")
    start_btn = page.query_selector("button:visible:has-text('게임 시작')")
    if not start_btn:
        # JS로 버튼 찾기
        start_btn = page.evaluate_handle("""
            () => Array.from(document.querySelectorAll('button'))
                       .find(b => b.offsetParent !== null && b.textContent.includes('시작'))
        """)
    try:
        if start_btn:
            start_btn.as_element().click()
            print("게임 시작 클릭")
            page.wait_for_timeout(7000)  # 5초 카운트다운 + 여유
    except Exception as e:
        print(f"시작 버튼 오류: {e}")

    evs2 = get_ws_events(page)
    countdown_events = [e for e in evs2 if e.get('type') == 'countdown']
    wave_events = [e for e in evs2 if e.get('type') == 'wave_start']
    print(f"카운트다운 이벤트: {len(countdown_events)}개")
    print(f"wave_start 이벤트: {len(wave_events)}개")
    if wave_events:
        print(f"wave_start 샘플: {json.dumps(wave_events[0], ensure_ascii=False)[:300]}")

    page.screenshot(path="/tmp/qa_ic_02_game.png")

    # ── 4. 원 그리기 (5회) + 대기 ───────────────────────────────────────────────
    print("\n=== [4] 주문 시전 (원×5) ===")
    canvas2 = page.query_selector("canvas")
    if canvas2:
        box = canvas2.bounding_box()
        if box:
            cx = box['x'] + box['width']//2
            cy = box['y'] + box['height']//2
            r = 70
            for attempt in range(5):
                page.mouse.move(cx + r, cy)
                page.mouse.down()
                for i in range(1, 40):
                    angle = (i / 39) * 2 * math.pi
                    page.mouse.move(cx + r*math.cos(angle), cy + r*math.sin(angle))
                    page.wait_for_timeout(7)
                page.mouse.up()
                page.wait_for_timeout(600)

                evs3 = get_ws_events(page)
                spell_evs = [e for e in evs3 if e.get('type') == 'spell_cast']
                hit_evs = [e for e in evs3 if e.get('type') == 'hit']
                shape_evs = [e for e in evs3 if e.get('type') == 'shape_recognized']
                print(f"  #{attempt+1}: spell_cast={len(spell_evs)} hit={len(hit_evs)} shape_recognized={len(shape_evs)}")

    page.screenshot(path="/tmp/qa_ic_03_draw.png")

    # ── 5. 30초 플레이 대기 (wave 진행) ─────────────────────────────────────────
    print("\n=== [5] 게임 플레이 30초 대기 ===")
    for tick in range(6):
        page.wait_for_timeout(5000)
        evs_curr = get_ws_events(page)
        type_cnt_curr = {}
        for e in evs_curr:
            t = e.get("type","?"); type_cnt_curr[t] = type_cnt_curr.get(t,0)+1
        combo = type_cnt_curr.get("co_combo_hit",0)
        surge = type_cnt_curr.get("elemental_surge",0)
        shield = type_cnt_curr.get("shield_defense",0)
        heal = type_cnt_curr.get("enemy_heal",0)
        wave = type_cnt_curr.get("wave_start",0)
        print(f"  +{(tick+1)*5}s: co_combo={combo} surge={surge} shield_def={shield} "
              f"heal={heal} wave={wave} 총={len(evs_curr)}")

        # 원 계속 그리기
        if canvas2 and box:
            page.mouse.move(cx + r, cy)
            page.mouse.down()
            for i in range(1, 28):
                angle = (i / 27) * 2 * math.pi
                page.mouse.move(cx + r*math.cos(angle), cy + r*math.sin(angle))
                page.wait_for_timeout(6)
            page.mouse.up()

    page.screenshot(path="/tmp/qa_ic_04_30s.png")

    # ── 6. 전체 WS 이벤트 분석 ──────────────────────────────────────────────────
    all_evs = get_ws_events(page)
    all_sent = get_ws_sent(page)
    print(f"\n=== [6] WS 이벤트 총 {len(all_evs)}개 (클라이언트 전송 {len(all_sent)}개) ===")

    type_cnt = {}
    for e in all_evs:
        t = e.get("type","?"); type_cnt[t] = type_cnt.get(t,0)+1
    print("수신 이벤트 타입:")
    for k,v in sorted(type_cnt.items()):
        print(f"  {k}: {v}회")

    sent_types = {}
    for e in all_sent:
        t = e.get("type","?"); sent_types[t] = sent_types.get(t,0)+1
    print(f"전송 이벤트 타입: {sent_types}")

    # ── 7. 핵심 이벤트 페이로드 샘플 ────────────────────────────────────────────
    print("\n=== [7] 핵심 이벤트 샘플 ===")
    key_types = ["co_combo_hit","elemental_surge","shield_defense","enemy_heal",
                 "wave_start","spell_cast","spell_result","shape_recognized",
                 "level_up","augment_options","state","connected"]
    for ev_type in key_types:
        sample = next((e for e in all_evs if e.get("type")==ev_type), None)
        if sample:
            print(f"\n  [{ev_type}]:")
            print(f"    {json.dumps(sample, ensure_ascii=False)[:400]}")

    # ── 8. routing-spec 준수 ──────────────────────────────────────────────────
    print("\n=== [8] routing-spec 준수 검증 ===")
    broadcast_spec = {"state","wave_start","wave_clear","wave_prep","enemy_spawn","enemy_die",
                      "enemy_heal","hit","co_combo_hit","spell_cast","attack_anim","boss_spawn",
                      "player_die","player_revive","player_disconnect","player_joined","player_left",
                      "host_changed","level_up","augment_selected","shape_unlocked","shape_recognized",
                      "countdown","game_over","advisor","shield_defense"}
    sendto_spec = {"spell_result","augment_options","level_up_queued","room_created","room_joined",
                   "room_error","connected","reconnected","error"}
    all_spec = broadcast_spec | sendto_spec
    unspec = set(type_cnt.keys()) - all_spec
    if unspec:
        print(f"⚠ spec 미정의: {unspec}")
    else:
        print("✓ 모든 수신 이벤트가 routing-spec 내")

    # ── 9. 엣지케이스: 마나 0 상태 주문 시도 ──────────────────────────────────
    print("\n=== [9] 엣지케이스: 마나 소진 후 주문 시도 ===")
    # 빠르게 10번 연속 주문
    prev_spell_cnt = type_cnt.get("spell_cast",0)
    prev_result_cnt = type_cnt.get("spell_result",0)
    if canvas2 and box:
        for _ in range(10):
            page.mouse.move(cx + r, cy)
            page.mouse.down()
            for i in range(1, 22):
                angle = (i / 21) * 2 * math.pi
                page.mouse.move(cx + r*math.cos(angle), cy + r*math.sin(angle))
                page.wait_for_timeout(5)
            page.mouse.up()
            page.wait_for_timeout(100)

    page.wait_for_timeout(1500)
    post_evs = get_ws_events(page)
    post_type = {}
    for e in post_evs:
        t = e.get("type","?"); post_type[t] = post_type.get(t,0)+1

    new_spells = post_type.get("spell_cast",0) - prev_spell_cnt
    new_results = post_type.get("spell_result",0) - prev_result_cnt
    # spell_result with reason
    fail_results = [e for e in post_evs if e.get("type")=="spell_result" and not e.get("success",True)]
    print(f"  연속 10회 → spell_cast {new_spells}개 추가, spell_result {new_results}개")
    if fail_results:
        print(f"  실패 결과 샘플: {json.dumps(fail_results[-1], ensure_ascii=False)[:200]}")

    # ── 10. 콘솔 오류 ─────────────────────────────────────────────────────────
    print("\n=== [10] 콘솔 오류 ===")
    errs = [l for l in logs if "[error]" in l.lower()]
    for l in errs[:10]:
        print(f"  {l}")
    if not errs:
        print("  없음")

    browser.close()
    print("\n=== QA 완료 ===")
