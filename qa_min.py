"""최소 진단 — 버튼 → WS 메시지 흐름 확인"""
from playwright.sync_api import sync_playwright
import json

LOCAL = "http://localhost:3000"
WS_INTERCEPT = """
window.__wsLog=[]; window.__wsSent=[];
const _OWS=window.WebSocket;
window.WebSocket=function(...a){
  const ws=new _OWS(...a);
  ws.addEventListener('message',e=>{try{window.__wsLog.push(JSON.parse(e.data));}catch(ex){console.error('parse err',e.data);}});
  const os=ws.send.bind(ws);
  ws.send=d=>{try{window.__wsSent.push(JSON.parse(d));}catch(ex){};return os(d);};
  return ws;
};
window.__clickBtn=function(text){
  const all=Array.from(document.querySelectorAll('button'));
  const b=all.find(b=>b.textContent.trim().includes(text)&&b.offsetParent!==null);
  const b2=all.find(b=>b.textContent.trim().includes(text));
  if(b){b.click();return 'visible-click';}
  if(b2){b2.click();return 'hidden-click';}
  return 'not-found';
};
"""

with sync_playwright() as p:
    br = p.chromium.launch(headless=True, args=["--no-sandbox"])
    ctx = br.new_context(viewport={"width":1280,"height":800})
    ctx.add_init_script(WS_INTERCEPT)
    pg = ctx.new_page()
    logs=[]
    pg.on("console", lambda m: logs.append(f"[{m.type}] {m.text[:300]}"))

    pg.goto(LOCAL, timeout=10000, wait_until="domcontentloaded")
    pg.wait_for_timeout(2000)

    # 현재 모든 버튼 목록 (visible/hidden 포함)
    all_btns = pg.evaluate("""
        () => Array.from(document.querySelectorAll('button')).map(b=>({
            text: b.textContent.trim(),
            visible: b.offsetParent !== null,
            display: window.getComputedStyle(b).display,
            id: b.id,
            cls: b.className
        }))
    """)
    print("=== 버튼 목록 ===")
    for b in all_btns:
        print(f"  '{b['text']}' visible={b['visible']} display={b['display']} id={b['id']}")

    # 초기 WS
    log0 = pg.evaluate("window.__wsLog||[]")
    sent0 = pg.evaluate("window.__wsSent||[]")
    print(f"\n초기 WS recv: {[e.get('type') for e in log0]}")
    print(f"초기 WS sent: {[e.get('type') for e in sent0]}")

    # 방 만들기 클릭
    r1 = pg.evaluate("window.__clickBtn('방 만들기')")
    print(f"\n방 만들기: {r1}")
    pg.wait_for_timeout(2000)

    log1 = pg.evaluate("window.__wsLog||[]")
    sent1 = pg.evaluate("window.__wsSent||[]")
    print(f"WS recv: {[e.get('type') for e in log1]}")
    print(f"WS sent: {[e.get('type') for e in sent1]}")

    # 버튼 목록 재확인
    all_btns2 = pg.evaluate("""
        () => Array.from(document.querySelectorAll('button')).map(b=>({
            text: b.textContent.trim(),
            visible: b.offsetParent !== null
        }))
    """)
    print(f"\n방 생성 후 버튼: {[(b['text'],b['visible']) for b in all_btns2]}")

    # 게임 시작
    r2 = pg.evaluate("window.__clickBtn('게임 시작')")
    print(f"\n게임 시작: {r2}")
    pg.wait_for_timeout(3000)

    log2 = pg.evaluate("window.__wsLog||[]")
    sent2 = pg.evaluate("window.__wsSent||[]")
    print(f"WS recv: {[e.get('type') for e in log2]}")
    print(f"WS sent: {[e.get('type') for e in sent2]}")

    # 콘솔 로그 전부
    print("\n=== 콘솔 로그 ===")
    for l in logs[:30]:
        print(f"  {l}")

    pg.screenshot(path="/tmp/qa_min.png")
    br.close()
    print("\n완료")
