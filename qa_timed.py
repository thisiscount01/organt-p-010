"""타임스탬프 디버깅 — 어디서 멈추는지 확인"""
import time, json, math
from playwright.sync_api import sync_playwright

LOCAL="http://localhost:3000"
T0=time.time()
def ts(): return f"+{round(time.time()-T0,1)}s"

WS_PATCH="""
window.__wsLog=[];
(function(){
  const _OWS=window.WebSocket;
  function PW(...a){const inst=new _OWS(...a);inst.addEventListener('message',function(e){try{window.__wsLog.push(JSON.parse(e.data));}catch(ex){}});return inst;}
  PW.prototype=_OWS.prototype;PW.CONNECTING=_OWS.CONNECTING;PW.OPEN=_OWS.OPEN;PW.CLOSING=_OWS.CLOSING;PW.CLOSED=_OWS.CLOSED;window.WebSocket=PW;
})();
"""
def wc(pg):
    c={}
    for e in pg.evaluate("window.__wsLog||[]"): t=e.get("type","?"); c[t]=c.get(t,0)+1
    return c
def click(pg,txt):
    return pg.evaluate(f"""(()=>{{const a=Array.from(document.querySelectorAll('button'));const b=a.find(b=>b.offsetParent!==null&&b.textContent.includes({json.dumps(txt)}))||a.find(b=>b.textContent.includes({json.dumps(txt)}));if(b){{b.dispatchEvent(new MouseEvent('click',{{bubbles:true,cancelable:true}}));return b.textContent.trim();}}return null;}})()""")
def draw(pg,cx,cy,r=70,n=14):
    pts=[(cx+r*math.cos((i/n)*2*math.pi),cy+r*math.sin((i/n)*2*math.pi)) for i in range(n+1)]
    pg.mouse.move(pts[0][0],pts[0][1]);pg.mouse.down()
    for x,y in pts[1:]:pg.mouse.move(x,y)
    pg.mouse.up()

with sync_playwright() as p:
    br=p.chromium.launch(headless=True,args=["--no-sandbox"])
    ctx=br.new_context(viewport={"width":1280,"height":800})
    ctx.add_init_script(WS_PATCH)
    pg=ctx.new_page()

    print(f"{ts()} goto...")
    pg.goto(LOCAL,timeout=10000,wait_until="domcontentloaded")
    print(f"{ts()} loaded, wait 2s...")
    pg.wait_for_timeout(2000)
    print(f"{ts()} LOAD done: {list(wc(pg).keys())}")

    print(f"{ts()} click room...")
    click(pg,"방 만들기")
    print(f"{ts()} wait 1.8s...")
    pg.wait_for_timeout(1800)
    print(f"{ts()} ROOM done: {list(wc(pg).keys())}")

    print(f"{ts()} click start...")
    click(pg,"게임 시작") or click(pg,"시작")
    print(f"{ts()} wait 7s (countdown)...")
    pg.wait_for_timeout(7000)
    print(f"{ts()} START done: {dict(sorted(wc(pg).items()))}")

    cv=pg.query_selector("canvas"); bx=cv.bounding_box() if cv else None
    cx2=cy2=0
    if bx: cx2=bx['x']+bx['width']//2; cy2=bx['y']+bx['height']//2
    print(f"{ts()} canvas box: {bx is not None}")

    print(f"{ts()} draw loop start (6x)...")
    for i in range(6):
        print(f"{ts()}   draw {i+1}/6...", flush=True)
        draw(pg,cx2,cy2)
        print(f"{ts()}   wait 350...", flush=True)
        pg.wait_for_timeout(350)
    c3=wc(pg)
    print(f"{ts()} DRAW done: spell={c3.get('spell_cast',0)} hit={c3.get('hit',0)}")

    print(f"{ts()} 2 extra draws...")
    draw(pg,cx2,cy2); pg.wait_for_timeout(400)
    draw(pg,cx2,cy2); pg.wait_for_timeout(400)
    print(f"{ts()} extra done")

    print(f"{ts()} wait 2000ms...")
    pg.wait_for_timeout(2000)
    print(f"{ts()} post-wait done")

    final=wc(pg)
    aev=pg.evaluate("window.__wsLog||[]")
    print(f"{ts()} FINAL: {dict(sorted(final.items()))}")

    for et in ["spell_result","co_combo_hit","enemy_heal","shield_defense","advisor"]:
        s=next((e for e in aev if e.get("type")==et),None)
        if s: print(f"  [{et}]: {json.dumps(s,ensure_ascii=False)[:200]}")

    pg.screenshot(path="/tmp/qa_timed.png")
    br.close()
print(f"{ts()} 완료")
