"""QA Playwright 검증 스크립트 — https://organt-p-010.onrender.com"""
from playwright.sync_api import sync_playwright
import json, time, math

TARGET = "https://organt-p-010.onrender.com"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    ctx = browser.new_context(viewport={"width":1280,"height":800}, ignore_https_errors=True)
    page = ctx.new_page()

    logs = []
    ws_events = []
    page_errors = []

    page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
    page.on("pageerror", lambda e: page_errors.append(str(e)))

    def on_ws(ws):
        def on_msg(f):
            try:
                data = json.loads(f.payload)
                ws_events.append(data)
            except:
                ws_events.append({"raw": str(f.payload)[:100]})
        ws.on("framereceived", on_msg)
    page.on("websocket", on_ws)

    # ── 1. 페이지 로드 ───────────────────────────────────────────────────────────
    print("=== [1] 페이지 로드 ===")
    t0 = time.time()
    try:
        page.goto(TARGET, timeout=40000, wait_until="networkidle")
        load_ms = round((time.time()-t0)*1000)
        print(f"로드 성공: {load_ms}ms")
    except Exception as e:
        print(f"로드 오류: {e}")
        load_ms = -1

    page.screenshot(path="/tmp/qa_01_load.png")
    print(f"스크린샷: /tmp/qa_01_load.png")

    title = page.title()
    print(f"타이틀: {title}")
    canvas = page.query_selector("canvas")
    print(f"캔버스: {'있음' if canvas else '없음'}")

    all_btns = page.query_selector_all("button")
    btn_texts = [b.inner_text().strip() for b in all_btns]
    print(f"버튼 목록: {btn_texts}")

    # ── 2. 방 생성 ───────────────────────────────────────────────────────────────
    print("\n=== [2] 방 생성 ===")
    create_btn = None
    for b in all_btns:
        t = b.inner_text().strip()
        if any(k in t for k in ["방 만들기","방만들기","새 방","만들기","Create","새방","혼자 시작","시작"]):
            create_btn = b
            break
    if not create_btn and btn_texts:
        create_btn = all_btns[0]  # 첫 번째 버튼 시도

    if create_btn:
        print(f"클릭: '{create_btn.inner_text().strip()}'")
        create_btn.click()
        page.wait_for_timeout(3000)
        page.screenshot(path="/tmp/qa_02_room.png")
        print("스크린샷: /tmp/qa_02_room.png")
        btns2 = page.query_selector_all("button")
        print(f"클릭 후 버튼: {[b.inner_text().strip() for b in btns2]}")
    else:
        print("방 생성 버튼 없음")

    # ── 3. 게임 시작 ─────────────────────────────────────────────────────────────
    print("\n=== [3] 게임 시작 ===")
    page.wait_for_timeout(1000)
    btns3 = page.query_selector_all("button")
    start_btn = None
    for b in btns3:
        t = b.inner_text().strip()
        if any(k in t for k in ["게임 시작","시작","Start","혼자"]):
            start_btn = b
            break
    if start_btn:
        print(f"클릭: '{start_btn.inner_text().strip()}'")
        try:
            start_btn.click(timeout=5000)
        except Exception as e:
            print(f"  클릭 실패: {e}")
        page.wait_for_timeout(6000)  # 카운트다운 대기
        page.screenshot(path="/tmp/qa_03_game.png")
        print("스크린샷: /tmp/qa_03_game.png")
    else:
        btns3_texts = [b.inner_text().strip() for b in btns3]
        print(f"시작 버튼 없음, 버튼: {btns3_texts}")

    # ── 4. 원 그리기 시뮬레이션 (마나 소모 주문 테스트) ──────────────────────────
    print("\n=== [4] 원 그리기 시뮬레이션 ===")
    canvas2 = page.query_selector("canvas")
    if canvas2:
        box = canvas2.bounding_box()
        if box:
            cx = box['x'] + box['width']//2
            cy = box['y'] + box['height']//2
            r = 60
            # 마우스 누르고 원 그리기
            page.mouse.move(cx + r, cy)
            page.mouse.down()
            for i in range(1, 37):
                angle = (i / 36) * 2 * math.pi
                page.mouse.move(cx + r*math.cos(angle), cy + r*math.sin(angle))
                page.wait_for_timeout(10)
            page.mouse.up()
            print("원 그리기 완료")
            page.wait_for_timeout(1000)
            page.screenshot(path="/tmp/qa_04_draw.png")
            print("스크린샷: /tmp/qa_04_draw.png")
        else:
            print("캔버스 bounding_box 없음")
    else:
        print("캔버스 없음 — 그리기 스킵")

    # ── 5. 추가 대기 후 최종 스크린샷 ────────────────────────────────────────────
    page.wait_for_timeout(5000)
    page.screenshot(path="/tmp/qa_05_final.png")

    # ── 6. WS 이벤트 분석 ────────────────────────────────────────────────────────
    print("\n=== [5] WS 이벤트 ===")
    type_count = {}
    for e in ws_events:
        t = e.get("type","raw")
        type_count[t] = type_count.get(t,0)+1
    print(f"총 {len(ws_events)}개 이벤트")
    for k,v in sorted(type_count.items()):
        print(f"  {k}: {v}회")

    # 관심 이벤트 페이로드 샘플
    interested = ["co_combo_hit","elemental_surge","shield_defense","enemy_heal","wave_start","state"]
    for ev_type in interested:
        sample = next((e for e in ws_events if e.get("type")==ev_type), None)
        if sample:
            print(f"\n  [{ev_type}] 샘플: {json.dumps(sample, ensure_ascii=False)[:300]}")

    # ── 7. 콘솔·페이지 오류 ──────────────────────────────────────────────────────
    print("\n=== [6] 콘솔 오류 ===")
    err_logs = [l for l in logs if "error" in l.lower() or "Error" in l]
    for l in err_logs[:10]:
        print(f"  {l}")
    if not err_logs:
        print("  없음")

    print(f"\n=== [7] 페이지 오류 ===")
    for e in page_errors[:5]:
        print(f"  {e}")
    if not page_errors:
        print("  없음")

    # ── 8. routing-spec 준수 확인 (수신된 이벤트 기준) ───────────────────────────
    print("\n=== [8] routing-spec 확인 ===")
    broadcast_expected = {"state","wave_start","wave_clear","wave_prep","enemy_spawn","enemy_die",
                          "enemy_heal","hit","co_combo_hit","spell_cast","attack_anim","boss_spawn",
                          "player_die","player_revive","level_up","augment_selected","shape_unlocked",
                          "shape_recognized","countdown","game_over","advisor","shield_defense"}
    sendto_expected = {"spell_result","augment_options","level_up_queued","room_created","room_joined",
                       "room_error","connected","reconnected","error"}
    recv_types = set(type_count.keys()) - {"raw"}
    unexpected_broadcast = recv_types - broadcast_expected - sendto_expected
    print(f"수신 이벤트 타입: {sorted(recv_types)}")
    if unexpected_broadcast:
        print(f"⚠ routing-spec 미정의 이벤트: {unexpected_broadcast}")
    else:
        print("routing-spec 정의 범위 내 이벤트만 수신")

    browser.close()
    print("\n=== 검증 완료 ===")
