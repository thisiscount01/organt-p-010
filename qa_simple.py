"""간단 진단"""
from playwright.sync_api import sync_playwright
import json, time

TARGET = "https://organt-p-010.onrender.com"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    ctx = browser.new_context(viewport={"width":1280,"height":800}, ignore_https_errors=True)
    page = ctx.new_page()

    logs = []
    ws_events = []
    ws_urls = []

    page.on("console", lambda m: logs.append(f"[{m.type}] {m.text[:200]}"))

    def on_ws(ws):
        ws_urls.append(ws.url)
        def on_msg(f):
            try:
                data = json.loads(f.payload)
                ws_events.append(data)
            except:
                pass
        ws.on("framereceived", on_msg)
    page.on("websocket", on_ws)

    t0 = time.time()
    page.goto(TARGET, timeout=40000, wait_until="domcontentloaded")
    print(f"DOM 로드: {round((time.time()-t0)*1000)}ms")
    page.wait_for_timeout(4000)

    # HTML 간략
    title = page.title()
    print(f"타이틀: {title}")
    canvas = page.query_selector("canvas")
    print(f"캔버스: {'있음' if canvas else '없음'}")

    # HTML body 요약
    try:
        body_text = page.inner_text("body")
        print(f"페이지 텍스트(처음 500자): {body_text[:500]}")
    except:
        pass

    # 버튼
    btns = page.query_selector_all("button")
    for b in btns:
        try:
            txt = b.inner_text().strip()
            vis = b.is_visible()
            print(f"버튼: '{txt}' visible={vis}")
        except:
            pass

    # WS 정보
    print(f"\nWS URL 목록: {ws_urls}")
    print(f"WS 이벤트 수: {len(ws_events)}")

    # 오류 로그
    err_logs = [l for l in logs if "error" in l.lower() or "400" in l or "WebSocket" in l]
    print(f"\n오류 로그 ({len(err_logs)}개):")
    for l in err_logs[:15]:
        print(f"  {l}")

    page.screenshot(path="/tmp/qa_simple.png")
    print("\n스크린샷: /tmp/qa_simple.png")

    browser.close()
