"""window.__sendWS 헬퍼로 직접 WS 메시지 주입해 QA"""
from playwright.sync_api import sync_playwright
import json, time, math

LOCAL = "http://localhost:3000"
WS_INTERCEPT = """
window.__wsLog=[]; window.__wsSent=[];
const _OWS=window.WebSocket;
window.WebSocket=function(...a){
  const ws=new _OWS(...a);
  ws.addEventListener('message',e=>{
    try{ const d=JSON.parse(e.data); window.__wsLog.push(d); }catch(ex){}
  });
  // prototype 레벨 인터셉트 (instance property override 보완)
  const proto = Object.getPrototypeOf(ws);
  if(!proto.__sendPatched){
    const origSend = proto.send;
    proto.send = function(d){
      try{ window.__wsSent.push(JSON.parse(d)); }catch(ex){}
      return origSend.call(this,d);
    };
    proto.__sendPatched = true;
  }
  return ws;
};
"""

def ws_log(page): return page.evaluate("window.__wsLog||[]")
def ws_sent(page): return page.evaluate("window.__wsSent||[]")
def ws_cnt(page):
    c={}
    for e in ws_log(page): t=e.get("type","?"); c[t]=c.get(t,0)+1
    return c

def send(page, msg):
    """game.js의 __sendWS 헬퍼로 WS 메시지 전송"""
    return page.evaluate(f"window.__sendWS && window.__sendWS({json.dumps(msg)})")

def draw_circle(page, cx, cy, r=70, steps=32):
    page.mouse.move(cx+r, cy)
    page.mouse.down()
    for i in range(1, steps+1):
        a=(i/steps)*2*math.pi
        page.mouse.move(cx+r*math.cos(a), cy+r*math.sin(a))
        page.wait_for_timeout(5)
    page.mouse.up()

with sync_playwright() as p:
    br = p.chromium.launch(headless=True, args=["--no-sandbox"])
    ctx = br.new_context(viewport={"width":1280,"height":800})
    ctx.add_init_script(WS_INTERCEPT)
    pg = ctx.new_page()
    logs=[]
    pg.on("console", lambda m: logs.append(f"[{m.type}] {m.text[:300]}"))

    # 1. 로드 & WS 연결 확인
    pg.goto(LOCAL, timeout=10000, wait_until="domcontentloaded")
    pg.wait_for_timeout(2500)
    c0 = ws_cnt(pg)
    print(f"[1] 로드 후 recv={c0}  sent={[e.get('type') for e in ws_sent(pg)]}")

    # 2. create_room 직접 전송
    send(pg, {"type":"create_room"})
    pg.wait_for_timeout(1500)
    c1 = ws_cnt(pg)
    sent1 = ws_sent(pg)
    print(f"[2] create_room 후 recv={c1}  sent={[e.get('type') for e in sent1]}")
    rc = next((e for e in ws_log(pg) if e.get("type")=="room_created"),None)
    if rc: print(f"    room_created: {json.dumps(rc,ensure_ascii=False)[:300]}")

    # 3. start_game 직접 전송
    send(pg, {"type":"start_game"})
    pg.wait_for_timeout(7000)  # 카운트다운 5초 + 여유
    c2 = ws_cnt(pg)
    print(f"[3] start_game 후 recv={c2}")
    wave_ev = next((e for e in ws_log(pg) if e.get("type")=="wave_start"),None)
    if wave_ev: print(f"    wave_start: {json.dumps(wave_ev,ensure_ascii=False)[:350]}")

    # 4. 원 그리기 6회 → spell_cast 유발
    canvas = pg.query_selector("canvas")
    box = canvas.bounding_box() if canvas else None
    if box:
        cx=box['x']+box['width']//2; cy=box['y']+box['height']//2
        for i in range(6):
            draw_circle(pg, cx, cy)
            pg.wait_for_timeout(500)
        print(f"[4] 원6회 후 spell_cast={ws_cnt(pg).get('spell_cast',0)} hit={ws_cnt(pg).get('hit',0)}")

    # 5. 8초 추가 대기 (적 AI 행동 포착)
    pg.wait_for_timeout(8000)

    # 최종 집계
    final = ws_cnt(pg)
    all_evs = ws_log(pg)
    all_sent = ws_sent(pg)
    print(f"\n=== 최종 이벤트 ({sum(final.values())}개) ===")
    for k,v in sorted(final.items()): print(f"  {k}: {v}")
    print(f"전송: {[e.get('type') for e in all_sent]}")

    print("\n=== 핵심 이벤트 샘플 ===")
    for et in ["connected","room_created","countdown","wave_start","spell_cast","hit",
               "co_combo_hit","elemental_surge","enemy_heal","shield_defense",
               "spell_result","shape_recognized","level_up","advisor"]:
        s=next((e for e in all_evs if e.get("type")==et),None)
        if s: print(f"  [{et}]\n    {json.dumps(s,ensure_ascii=False)[:350]}")

    # routing-spec
    b_sp={"state","wave_start","wave_clear","wave_prep","enemy_spawn","enemy_die","enemy_heal",
          "hit","co_combo_hit","spell_cast","attack_anim","boss_spawn","player_die","player_revive",
          "player_disconnect","player_joined","player_left","host_changed","level_up","augment_selected",
          "shape_unlocked","shape_recognized","countdown","game_over","advisor","shield_defense"}
    s_sp={"spell_result","augment_options","level_up_queued","room_created","room_joined",
          "room_error","connected","reconnected","error"}
    unsp=set(final.keys())-(b_sp|s_sp)
    print(f"\n[routing-spec] 미정의: {unsp or '없음(준수)'}")

    # 오류
    errs=[l for l in logs if "[error]" in l]
    print(f"\n[콘솔 오류 {len(errs)}개]: {errs[:5] if errs else '없음'}")

    pg.screenshot(path="/tmp/qa_ws_final.png")
    br.close()
    print("\n완료")
