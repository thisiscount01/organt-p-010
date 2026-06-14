"""서버 로그 기반 QA — 실제 이벤트 발생을 서버 측에서 확인"""
from playwright.sync_api import sync_playwright
import json, time, math

LOCAL = "http://localhost:3000"

# __sendWS + 로그 수집
WS_PATCH = """
window.__wsLog=[];
const _OWS=window.WebSocket;
window.WebSocket=function(...a){
  const inst=new _OWS(...a);
  // message: onmessage 직접 설정 후 래핑
  const origOnMsg = Object.getOwnPropertyDescriptor(_OWS.prototype,'onmessage');
  inst.addEventListener('message', e=>{
    try{ window.__wsLog.push(JSON.parse(e.data)); }catch(ex){}
  });
  return inst;
};
"""

def ws_log(page): return page.evaluate("window.__wsLog||[]")
def ws_cnt(page):
    c={}
    for e in ws_log(page): t=e.get("type","?"); c[t]=c.get(t,0)+1
    return c

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
    ctx.add_init_script(WS_PATCH)
    pg = ctx.new_page()

    pg.goto(LOCAL, timeout=10000, wait_until="domcontentloaded")
    pg.wait_for_timeout(2000)

    # WS 상태 직접 확인
    ws_state = pg.evaluate("""
        () => {
            const w = window.__wsInst;
            if (!w) return 'no __wsInst';
            return {readyState: w.readyState, url: w.url};
        }
    """)
    print(f"[1] 로드 후 WS 상태: {ws_state}")
    print(f"    recv: {list(ws_cnt(pg).keys())}")
    print(f"    __sendWS 있음: {pg.evaluate('typeof window.__sendWS !== \"undefined\"')}")

    # readyState 직접 확인
    rs = pg.evaluate("""
        () => {
            // game.js 내부 ws에 접근 불가이므로 WebSocket 연결 상태를 전역에서 파악
            const sockets = [];
            return {
                wsLog_count: (window.__wsLog||[]).length,
                hasConnected: (window.__wsLog||[]).some(e=>e.type==='connected'),
                sendWSType: typeof window.__sendWS
            };
        }
    """)
    print(f"    진단: {rs}")

    # 버튼 클릭 (방 만들기)
    pg.evaluate("window.__clickBtn=function(t){ const b=Array.from(document.querySelectorAll('button')).find(b=>b.offsetParent!==null&&b.textContent.includes(t))||Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes(t)); if(b){b.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); return true;} return false; }")
    r1 = pg.evaluate("window.__clickBtn('방 만들기')")
    print(f"\n[2] 방 만들기 click-dispatch: {r1}")
    pg.wait_for_timeout(2000)
    print(f"    recv: {ws_cnt(pg)}")
    print(f"    room_created: {next((e for e in ws_log(pg) if e.get('type')=='room_created'), None)}")

    # 게임 시작
    r2 = pg.evaluate("window.__clickBtn('게임 시작')||window.__clickBtn('시작')")
    print(f"\n[3] 게임 시작 click-dispatch: {r2}")
    pg.wait_for_timeout(7000)
    c2 = ws_cnt(pg)
    print(f"    recv: {c2}")
    wave = next((e for e in ws_log(pg) if e.get("type")=="wave_start"),None)
    if wave: print(f"    wave_start: {json.dumps(wave,ensure_ascii=False)[:300]}")

    # 원 6회
    canvas=pg.query_selector("canvas"); box=canvas.bounding_box() if canvas else None
    if box:
        cx=box['x']+box['width']//2; cy=box['y']+box['height']//2
        for i in range(6):
            draw_circle(pg, cx, cy)
            pg.wait_for_timeout(600)
        c3=ws_cnt(pg)
        print(f"\n[4] 원6회 후: spell_cast={c3.get('spell_cast',0)} hit={c3.get('hit',0)} shape={c3.get('shape_recognized',0)}")

    # 10초 대기
    pg.wait_for_timeout(8000)

    final=ws_cnt(pg); all_e=ws_log(pg)
    print(f"\n=== 최종 ({sum(final.values())}개) ===")
    for k,v in sorted(final.items()): print(f"  {k}: {v}")

    print("\n=== 핵심 샘플 ===")
    for et in ["connected","room_created","countdown","wave_start","spell_cast",
               "hit","co_combo_hit","enemy_heal","shield_defense","spell_result",
               "shape_recognized","advisor"]:
        s=next((e for e in all_e if e.get("type")==et),None)
        if s: print(f"  [{et}] {json.dumps(s,ensure_ascii=False)[:300]}")

    pg.screenshot(path="/tmp/qa_slog.png")
    br.close()
    print("\n완료")
