"""QA 심층 진단 스크립트"""
from playwright.sync_api import sync_playwright
import json, time, math

TARGET = "https://organt-p-010.onrender.com"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    ctx = browser.new_context(
        viewport={"width":1280,"height":800},
        ignore_https_errors=True
    )
    page = ctx.new_page()

    logs = []
    ws_events = []

    page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))

    def on_ws(ws):
        print(f"  WS 연결: {ws.url}")
        def on_msg(f):
            try:
                data = json.loads(f.payload)
                ws_events.append(data)
                t = data.get("type","?")
                if t not in ("state",):  # state는 너무 많으니 제외
                    print(f"  WS recv: {json.dumps(data, ensure_ascii=False)[:200]}")
            except:
                ws_events.append({"raw": str(f.payload)[:100]})
        def on_sent(f):
            try:
                data = json.loads(f.payload)
                print(f"  WS send: {json.dumps(data, ensure_ascii=False)[:200]}")
            except:
                pass
        ws.on("framereceived", on_msg)
        ws.on("framesent", on_sent)
        ws.on("close", lambda: print(f"  WS 닫힘: {ws.url}"))
    page.on("websocket", on_ws)

    # 1. 로드
    print("=== 페이지 로드 ===")
    t0 = time.time()
    page.goto(TARGET, timeout=40000, wait_until="domcontentloaded")
    load_ms = round((time.time()-t0)*1000)
    print(f"로드: {load_ms}ms")
    page.wait_for_timeout(3000)

    # HTML 구조 dump
    body = page.inner_html("body")
    print(f"\n--- HTML 요약 (처음 2000자) ---")
    print(body[:2000])
    print("---")

    # 화면 캡처
    page.screenshot(path="/tmp/qa_diag_01.png", full_page=True)
    print("\n스크린샷: /tmp/qa_diag_01.png")

    # 버튼 상세
    print("\n=== 버튼 목록 (visible 여부 포함) ===")
    btns = page.query_selector_all("button")
    for b in btns:
        try:
            txt = b.inner_text().strip()
            vis = b.is_visible()
            enabled = b.is_enabled()
            print(f"  '{txt}' visible={vis} enabled={enabled}")
        except:
            pass

    # 모든 클릭 가능 요소
    print("\n=== 클릭 가능 요소 (div[onclick], a, input) ===")
    clickables = page.query_selector_all("[onclick], a[href], input[type=button], input[type=submit]")
    for c in clickables[:10]:
        try:
            desc = c.evaluate('el => el.tagName + ": " + (el.innerText || el.value || el.id)')
            print(f"  {desc}")
        except:
            pass

    # 2. 방 만들기 - force click 시도
    print("\n=== 방 만들기 시도 ===")
    btns = page.query_selector_all("button")
    for b in btns:
        try:
            txt = b.inner_text().strip()
            if any(k in txt for k in ["방","만들","시작","Play","혼자"]):
                print(f"  force-click: '{txt}'")
                b.click(force=True)
                page.wait_for_timeout(2000)
                break
        except Exception as e:
            print(f"  오류: {e}")

    page.screenshot(path="/tmp/qa_diag_02.png", full_page=True)
    page.wait_for_timeout(2000)

    # 3. 게임 시작 버튼 시도
    print("\n=== 게임 시작 시도 ===")
    btns2 = page.query_selector_all("button")
    for b in btns2:
        try:
            txt = b.inner_text().strip()
            vis = b.is_visible()
            print(f"  '{txt}' visible={vis}")
            if any(k in txt for k in ["시작","Start","게임"]) and vis:
                b.click(timeout=3000)
                print(f"  클릭 성공: '{txt}'")
                page.wait_for_timeout(8000)
                break
        except Exception as e:
            print(f"  '{txt}' 클릭 실패: {e}")

    page.screenshot(path="/tmp/qa_diag_03.png", full_page=True)

    # 4. WS 이벤트 요약
    print(f"\n=== WS 이벤트 총 {len(ws_events)}개 ===")
    type_cnt = {}
    for e in ws_events:
        t = e.get("type","raw")
        type_cnt[t] = type_cnt.get(t,0)+1
    for k,v in sorted(type_cnt.items()):
        print(f"  {k}: {v}")

    # 5. WS 오류 로그
    print("\n=== WS/콘솔 오류 ===")
    for l in logs:
        if "error" in l.lower() or "Error" in l or "ws" in l.lower() or "400" in l:
            print(f"  {l}")

    browser.close()
    print("\n=== 진단 완료 ===")
