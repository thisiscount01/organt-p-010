"""로컬 서버 상대로 QA — WS 실제 동작 검증"""
from playwright.sync_api import sync_playwright
import json, time, math, subprocess, os, signal

LOCAL = "http://localhost:3000"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    ctx = browser.new_context(viewport={"width":1280,"height":800})
    page = ctx.new_page()

    logs = []
    ws_events = []
    ws_sent = []

    page.on("console", lambda m: logs.append(f"[{m.type}] {m.text[:300]}"))

    def on_ws(ws):
        print(f"  WS 연결됨: {ws.url}")
        def on_msg(f):
            try:
                data = json.loads(f.payload)
                ws_events.append(data)
                t = data.get("type","?")
                if t not in ("state",):
                    print(f"  << {t}: {json.dumps(data, ensure_ascii=False)[:200]}")
            except:
                pass
        def on_sent(f):
            try:
                data = json.loads(f.payload)
                ws_sent.append(data)
                print(f"  >> {data.get('type','?')}: {json.dumps(data, ensure_ascii=False)[:100]}")
            except:
                pass
        ws.on("framereceived", on_msg)
        ws.on("framesent", on_sent)
        ws.on("close", lambda: print("  WS 닫힘"))
    page.on("websocket", on_ws)

    # 1. 로드
    print("=== [1] 로컬 서버 로드 ===")
    t0 = time.time()
    page.goto(LOCAL, timeout=10000, wait_until="domcontentloaded")
    print(f"로드: {round((time.time()-t0)*1000)}ms")
    page.wait_for_timeout(2000)

    canvas = page.query_selector("canvas")
    print(f"캔버스: {'있음' if canvas else '없음'}")

    # 2. 방 만들기
    print("\n=== [2] 방 만들기 ===")
    create_btn = page.query_selector("button:has-text('방 만들기')")
    if not create_btn:
        create_btn = page.query_selector("button:has-text('혼자')")
    if create_btn:
        create_btn.click()
        page.wait_for_timeout(2000)
        print("방 만들기 클릭")
    else:
        btns = [b.inner_text().strip() for b in page.query_selector_all("button") if b.is_visible()]
        print(f"방 만들기 버튼 없음, 버튼: {btns}")

    page.screenshot(path="/tmp/qa_local_01_room.png")

    # 3. 게임 시작
    print("\n=== [3] 게임 시작 ===")
    start_btn = page.query_selector("button:has-text('게임 시작')")
    if not start_btn:
        start_btn = page.query_selector("button:has-text('시작')")
    if start_btn and start_btn.is_visible():
        start_btn.click()
        print("게임 시작 클릭")
        page.wait_for_timeout(6000)  # 카운트다운
    else:
        vis_btns = [b.inner_text().strip() for b in page.query_selector_all("button") if b.is_visible()]
        print(f"시작 버튼 없음, 보이는 버튼: {vis_btns}")

    page.screenshot(path="/tmp/qa_local_02_game.png")

    # 4. 원 그리기 (3번)
    print("\n=== [4] 원 그리기 ===")
    canvas2 = page.query_selector("canvas")
    if canvas2:
        box = canvas2.bounding_box()
        if box:
            cx = box['x'] + box['width']//2
            cy = box['y'] + box['height']//2
            r = 65

            for attempt in range(3):
                page.mouse.move(cx + r, cy)
                page.mouse.down()
                for i in range(1, 40):
                    angle = (i / 39) * 2 * math.pi
                    page.mouse.move(cx + r*math.cos(angle), cy + r*math.sin(angle))
                    page.wait_for_timeout(8)
                page.mouse.up()
                print(f"  원 그리기 {attempt+1}/3 완료")
                page.wait_for_timeout(800)

            page.screenshot(path="/tmp/qa_local_03_draw.png")

    # 5. 5초 게임 플레이 대기
    print("\n=== [5] 게임 플레이 5초 대기 ===")
    page.wait_for_timeout(5000)
    page.screenshot(path="/tmp/qa_local_04_play.png")

    # 6. WS 이벤트 분석
    print(f"\n=== [6] WS 이벤트 총 {len(ws_events)}개 ===")
    type_cnt = {}
    for e in ws_events:
        t = e.get("type","raw")
        type_cnt[t] = type_cnt.get(t,0)+1

    print("이벤트 타입별 수신:")
    for k,v in sorted(type_cnt.items()):
        print(f"  {k}: {v}회")

    # co_combo_hit, elemental_surge, shield_defense, enemy_heal 샘플
    for ev_type in ["co_combo_hit","elemental_surge","shield_defense","enemy_heal","wave_start","state","spell_result","connected"]:
        sample = next((e for e in ws_events if e.get("type")==ev_type), None)
        if sample:
            print(f"\n  [{ev_type}] 샘플:")
            print(f"    {json.dumps(sample, ensure_ascii=False)[:400]}")

    # 7. routing-spec 검증
    print("\n=== [7] routing-spec 준수 검증 ===")
    broadcast_spec = {"state","wave_start","wave_clear","wave_prep","enemy_spawn","enemy_die",
                      "enemy_heal","hit","co_combo_hit","spell_cast","attack_anim","boss_spawn",
                      "player_die","player_revive","player_disconnect","player_joined","player_left",
                      "host_changed","level_up","augment_selected","shape_unlocked","shape_recognized",
                      "countdown","game_over","advisor","shield_defense"}
    sendto_spec = {"spell_result","augment_options","level_up_queued","room_created","room_joined",
                   "room_error","connected","reconnected","error"}
    all_spec = broadcast_spec | sendto_spec
    recv_types = set(type_cnt.keys())
    unspec = recv_types - all_spec
    print(f"수신 타입: {sorted(recv_types)}")
    if unspec:
        print(f"⚠ spec 외 이벤트: {unspec}")
    else:
        print("✓ 모든 이벤트가 routing-spec 범위 내")

    # 8. 오류
    print("\n=== [8] 콘솔 오류 ===")
    errs = [l for l in logs if "[error]" in l.lower()]
    for l in errs[:10]:
        print(f"  {l}")
    if not errs:
        print("  없음")

    browser.close()
    print("\n=== 완료 ===")
