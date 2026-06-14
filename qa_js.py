"""JS 직접 제어 QA — 버튼 텍스트 기반 클릭"""
from playwright.sync_api import sync_playwright
import json, time, math

LOCAL = "http://localhost:3000"
WS_INTERCEPT = """
window.__wsLog=[]; window.__wsSent=[];
const _OWS=window.WebSocket;
window.WebSocket=function(...a){
  const ws=new _OWS(...a);
  ws.addEventListener('message',e=>{try{window.__wsLog.push(JSON.parse(e.data));}catch(ex){}});
  const os=ws.send.bind(ws);
  ws.send=d=>{try{window.__wsSent.push(JSON.parse(d));}catch(ex){};return os(d);};
  return ws;
};
// 버튼 클릭 헬퍼
window.__clickBtn=function(text){
  const b=Array.from(document.querySelectorAll('button'))
    .find(b=>b.textContent.trim().includes(text));
  if(b){b.click();return true;}return false;
};
"""

def ws_log(page): return page.evaluate("window.__wsLog||[]")
def ws_cnt(page):
    c={}
    for e in ws_log(page): t=e.get("type","?"); c[t]=c.get(t,0)+1
    return c

def draw_circle(page, cx, cy, r=65, steps=28):
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
    pg.on("console", lambda m: logs.append(f"[{m.type}] {m.text[:200]}"))

    # 1. 로드
    pg.goto(LOCAL, timeout=10000, wait_until="domcontentloaded")
    pg.wait_for_timeout(2000)
    print(f"캔버스: {'있음' if pg.query_selector('canvas') else '없음'}")
    print(f"초기WS: {list(ws_cnt(pg).keys())}")

    # 2. 방 만들기
    r1 = pg.evaluate("window.__clickBtn('방 만들기')")
    print(f"방 만들기 클릭: {r1}")
    pg.wait_for_timeout(1800)
    c1 = ws_cnt(pg)
    print(f"방 생성 후 WS: {c1}")

    # room_created 이벤트 확인
    rc = next((e for e in ws_log(pg) if e.get('type')=='room_created'), None)
    if rc: print(f"  room_created: {json.dumps(rc, ensure_ascii=False)[:200]}")

    # 3. 게임 시작 — JS 클릭
    r2 = pg.evaluate("window.__clickBtn('게임 시작')")
    if not r2:
        r2 = pg.evaluate("window.__clickBtn('시작')")
    print(f"게임 시작 클릭: {r2}")
    # 카운트다운 6초 대기
    pg.wait_for_timeout(6500)
    c2 = ws_cnt(pg)
    print(f"게임 시작 후 WS: {c2}")

    ws_sample = ws_log(pg)
    wave_ev = next((e for e in ws_sample if e.get('type')=='wave_start'), None)
    if wave_ev: print(f"  wave_start: {json.dumps(wave_ev, ensure_ascii=False)[:300]}")

    # 4. 원 그리기 8회
    canvas = pg.query_selector("canvas")
    box = canvas.bounding_box() if canvas else None
    if box:
        cx=box['x']+box['width']//2; cy=box['y']+box['height']//2
        for _ in range(8):
            draw_circle(pg, cx, cy)
            pg.wait_for_timeout(500)

    pg.wait_for_timeout(5000)
    c3 = ws_cnt(pg)
    print(f"\n[원 8회 후 이벤트] {c3}")

    # 5. 10초 추가 대기 (웨이브 진행, 적 AI)
    if box:
        for _ in range(3):
            draw_circle(pg, cx, cy)
            pg.wait_for_timeout(800)
    pg.wait_for_timeout(6000)

    final = ws_cnt(pg)
    all_evs = ws_log(pg)
    print(f"\n=== 최종 이벤트 ({sum(final.values())}개) ===")
    for k,v in sorted(final.items()): print(f"  {k}: {v}")

    # 핵심 이벤트 페이로드
    print("\n=== 핵심 이벤트 샘플 ===")
    for et in ["co_combo_hit","elemental_surge","shield_defense","enemy_heal",
               "wave_start","wave_clear","spell_cast","spell_result",
               "shape_recognized","level_up","connected","state"]:
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
    print(f"\n[routing-spec 미정의]: {unsp or '없음'}")

    # 오류
    errs=[l for l in logs if "[error]" in l]
    print(f"\n[콘솔 오류 {len(errs)}개]")
    for l in errs[:8]: print(f"  {l}")
    if not errs: print("  없음")

    pg.screenshot(path="/tmp/qa_js_final.png")
    br.close()
    print("\n완료")
