"""QA 보고서 v2 — 서버는 외부에서 시작, 이 스크립트는 playwright만"""
import time, json, math, sys
from playwright.sync_api import sync_playwright

LOCAL = "http://localhost:3000"
WS_PATCH="""
window.__wsLog=[];
(function(){
  const _OWS=window.WebSocket;
  function PW(...a){
    const inst=new _OWS(...a);
    inst.addEventListener('message',function(e){try{window.__wsLog.push(JSON.parse(e.data));}catch(ex){}});
    return inst;
  }
  PW.prototype=_OWS.prototype;
  PW.CONNECTING=_OWS.CONNECTING;PW.OPEN=_OWS.OPEN;
  PW.CLOSING=_OWS.CLOSING;PW.CLOSED=_OWS.CLOSED;
  window.WebSocket=PW;
})();
"""

def wl(pg): return pg.evaluate("window.__wsLog||[]")
def wc(pg):
    c={}
    for e in wl(pg): t=e.get("type","?"); c[t]=c.get(t,0)+1
    return c
def click(pg,text):
    return pg.evaluate(f"""(()=>{{const a=Array.from(document.querySelectorAll('button'));const b=a.find(b=>b.offsetParent!==null&&b.textContent.includes({json.dumps(text)}))||a.find(b=>b.textContent.includes({json.dumps(text)}));if(b){{b.dispatchEvent(new MouseEvent('click',{{bubbles:true,cancelable:true}}));return b.textContent.trim();}}return null;}})()""")
def draw(pg,cx,cy,r=70,n=16):
    pts=[(cx+r*math.cos((i/n)*2*math.pi),cy+r*math.sin((i/n)*2*math.pi)) for i in range(n+1)]
    pg.mouse.move(pts[0][0],pts[0][1]);pg.mouse.down()
    for x,y in pts[1:]:pg.mouse.move(x,y)
    pg.mouse.up()

print("QA 시작...")

with sync_playwright() as p:
    br=p.chromium.launch(headless=True,args=["--no-sandbox"])
    ctx=br.new_context(viewport={"width":1280,"height":800})
    ctx.add_init_script(WS_PATCH)
    pg=ctx.new_page()
    logs=[]; pg.on("console",lambda m:logs.append(f"[{m.type}] {m.text[:200]}"))

    # 로드
    pg.goto(LOCAL,timeout=10000,wait_until="domcontentloaded"); pg.wait_for_timeout(2000)
    c0=wc(pg)
    print(f"LOAD: canvas={'Y' if pg.query_selector('canvas') else 'N'} WS={list(c0.keys())}")

    # 방 만들기
    r1=click(pg,"방 만들기"); pg.wait_for_timeout(1800)
    c1=wc(pg)
    rc=next((e for e in wl(pg) if e.get("type")=="room_created"),None)
    print(f"ROOM: click='{r1}' recv={list(c1.keys())}")
    if rc: print(f"  room_created: code={rc.get('roomCode')} maxP={rc.get('maxPlayers')} shapes={rc.get('initialShapes')}")

    # 게임 시작
    r2=click(pg,"게임 시작") or click(pg,"시작"); pg.wait_for_timeout(7000)
    c2=wc(pg)
    print(f"START: click='{r2}' recv={dict(sorted(c2.items()))}")
    wev=next((e for e in wl(pg) if e.get("type")=="wave_start"),None)
    if wev: print(f"  wave_start: wave={wev.get('waveNumber')} enemies={wev.get('enemyCount')} boss={wev.get('hasBoss')}")

    # 원 8회
    cv=pg.query_selector("canvas"); bx=cv.bounding_box() if cv else None
    if bx:
        cx=bx['x']+bx['width']//2; cy=bx['y']+bx['height']//2
        for _ in range(8): draw(pg,cx,cy); pg.wait_for_timeout(350)
    c3=wc(pg)
    print(f"DRAW8: spell={c3.get('spell_cast',0)} hit={c3.get('hit',0)} shape={c3.get('shape_recognized',0)}")
    sc=next((e for e in wl(pg) if e.get('type')=='spell_cast'),None)
    if sc: print(f"  spell_cast: shape={sc.get('shape')} type={sc.get('spellType')} conf={sc.get('confidence')} tier={sc.get('tier')}")

    # 5초 대기 (적 AI)
    if bx:
        for _ in range(2): draw(pg,cx,cy); pg.wait_for_timeout(500)
    pg.wait_for_timeout(2500)

    final=wc(pg); aev=wl(pg)
    print(f"FINAL: total={sum(final.values())} types={dict(sorted(final.items()))}")

    # 핵심 샘플
    for et in ["spell_result","shape_recognized","co_combo_hit","enemy_heal","shield_defense","level_up","advisor"]:
        s=next((e for e in aev if e.get("type")==et),None)
        if s: print(f"  [{et}]: {json.dumps(s,ensure_ascii=False)[:250]}")

    # routing-spec
    b_sp={"state","wave_start","wave_clear","wave_prep","enemy_spawn","enemy_die","enemy_heal",
          "hit","co_combo_hit","spell_cast","attack_anim","boss_spawn","player_die","player_revive",
          "player_disconnect","player_joined","player_left","host_changed","level_up","augment_selected",
          "shape_unlocked","shape_recognized","countdown","game_over","advisor","shield_defense"}
    s_sp={"spell_result","augment_options","level_up_queued","room_created","room_joined",
          "room_error","connected","reconnected","error"}
    unsp=set(final.keys())-(b_sp|s_sp)
    print(f"ROUTING: ok={not unsp} extra={unsp or 'none'}")

    # 엣지: 연속 10회
    if bx:
        for _ in range(10): draw(pg,cx,cy); pg.wait_for_timeout(50)
    pg.wait_for_timeout(800)
    post=wc(pg)
    fail_ev=next((e for e in wl(pg) if e.get('type')=='spell_result' and not e.get('success')),None)
    print(f"EDGE: spell_fail={'Y' if fail_ev else 'N'}")
    if fail_ev: print(f"  fail: {json.dumps(fail_ev,ensure_ascii=False)[:200]}")

    errs=[l for l in logs if '[error]' in l]
    print(f"ERRORS: {len(errs)} — {errs[:3] if errs else 'none'}")

    pg.screenshot(path="/tmp/qa2_final.png")
    br.close()

print("완료")
