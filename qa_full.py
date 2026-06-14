"""서버+playwright 통합 QA — subprocess로 서버 로그 직접 캡처"""
import subprocess, threading, time, json, math, sys, os
from playwright.sync_api import sync_playwright

WORK = os.path.dirname(os.path.abspath(__file__))
LOCAL = "http://localhost:3000"

# ── 서버 시작 ─────────────────────────────────────────────────────────────────
server_lines = []
def read_server(proc):
    for line in iter(proc.stdout.readline, b''):
        l = line.decode('utf-8','replace').rstrip()
        server_lines.append(l)
        sys.stdout.write(f"[SRV] {l}\n"); sys.stdout.flush()

srv = subprocess.Popen(
    ["node", "server.js"],
    cwd=WORK,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT
)
t = threading.Thread(target=read_server, args=(srv,), daemon=True)
t.start()
time.sleep(2.5)

# ── WS 인터셉트 ────────────────────────────────────────────────────────────────
WS_PATCH = """
window.__wsLog=[];
(function(){
  const _OWS=window.WebSocket;
  function PW(...a){
    const inst=new _OWS(...a);
    inst.addEventListener('message',function(e){
      try{ window.__wsLog.push(JSON.parse(e.data)); }catch(ex){}
    });
    return inst;
  }
  PW.prototype=_OWS.prototype;
  PW.CONNECTING=_OWS.CONNECTING; PW.OPEN=_OWS.OPEN;
  PW.CLOSING=_OWS.CLOSING; PW.CLOSED=_OWS.CLOSED;
  window.WebSocket=PW;
})();
"""

def wl(pg): return pg.evaluate("window.__wsLog||[]")
def wc(pg):
    c={}
    for e in wl(pg): t=e.get("type","?"); c[t]=c.get(t,0)+1
    return c
def click(pg, text):
    return pg.evaluate(f"""
    (()=>{{
      const all=Array.from(document.querySelectorAll('button'));
      const b=all.find(b=>b.offsetParent!==null&&b.textContent.includes({json.dumps(text)}))
              ||all.find(b=>b.textContent.includes({json.dumps(text)}));
      if(b){{b.dispatchEvent(new MouseEvent('click',{{bubbles:true,cancelable:true}}));return b.textContent.trim();}}
      return null;
    }})()
    """)
def draw(pg, cx, cy, r=70, n=16):
    """원 그리기 — n 스텝, 내부 wait 없음 (playwright 오버헤드 최소화)"""
    pts=[(cx+r*math.cos((i/n)*2*math.pi), cy+r*math.sin((i/n)*2*math.pi)) for i in range(n+1)]
    pg.mouse.move(pts[0][0], pts[0][1]); pg.mouse.down()
    for x,y in pts[1:]: pg.mouse.move(x,y)
    pg.mouse.up()

# ── playwright 테스트 ──────────────────────────────────────────────────────────
try:
    with sync_playwright() as p:
        br = p.chromium.launch(headless=True, args=["--no-sandbox"])
        ctx = br.new_context(viewport={"width":1280,"height":800})
        ctx.add_init_script(WS_PATCH)
        pg = ctx.new_page()
        logs=[]; pg.on("console", lambda m: logs.append(f"[{m.type}] {m.text[:200]}"))

        # 1. 로드
        pg.goto(LOCAL, timeout=10000, wait_until="domcontentloaded")
        pg.wait_for_timeout(2000)
        c0=wc(pg)
        print(f"\n[1] 로드: canvas={'있음' if pg.query_selector('canvas') else '없음'} recv={list(c0.keys())}")
        print(f"    __sendWS={pg.evaluate('typeof window.__sendWS')}")

        # 2. 방 만들기
        r1=click(pg,"방 만들기"); pg.wait_for_timeout(2000)
        print(f"[2] 방만들기='{r1}' recv={list(wc(pg).keys())}")
        rc=next((e for e in wl(pg) if e.get("type")=="room_created"),None)
        if rc: print(f"    room_created={json.dumps(rc,ensure_ascii=False)[:200]}")

        # 3. 게임 시작
        r2=click(pg,"게임 시작") or click(pg,"시작")
        pg.wait_for_timeout(7000)
        c2=wc(pg)
        print(f"[3] 게임시작='{r2}' recv={c2}")
        wev=next((e for e in wl(pg) if e.get("type")=="wave_start"),None)
        if wev: print(f"    wave_start={json.dumps(wev,ensure_ascii=False)[:300]}")

        # 4. 원 그리기 6회
        cv=pg.query_selector("canvas"); bx=cv.bounding_box() if cv else None
        if bx:
            cx=bx['x']+bx['width']//2; cy=bx['y']+bx['height']//2
            for _ in range(6): draw(pg,cx,cy); pg.wait_for_timeout(400)
        c3=wc(pg)
        print(f"[4] 원6회: spell={c3.get('spell_cast',0)} hit={c3.get('hit',0)} shape={c3.get('shape_recognized',0)}")

        # 5. 5초 대기 (적 AI)
        if bx:
            for _ in range(2): draw(pg,cx,cy); pg.wait_for_timeout(700)
        pg.wait_for_timeout(3000)

        # 최종
        final=wc(pg); aev=wl(pg)
        print(f"\n=== 최종 WS 이벤트 ({sum(final.values())}개) ===")
        for k,v in sorted(final.items()): print(f"  {k}: {v}")

        print("\n=== 핵심 이벤트 샘플 ===")
        for et in ["connected","room_created","countdown","wave_start","spell_cast","hit",
                   "shape_recognized","spell_result","co_combo_hit","enemy_heal",
                   "shield_defense","level_up","advisor"]:
            s=next((e for e in aev if e.get("type")==et),None)
            if s: print(f"  [{et}]\n    {json.dumps(s,ensure_ascii=False)[:350]}")

        # routing-spec
        b_sp={"state","wave_start","wave_clear","wave_prep","enemy_spawn","enemy_die",
              "enemy_heal","hit","co_combo_hit","spell_cast","attack_anim","boss_spawn",
              "player_die","player_revive","player_disconnect","player_joined","player_left",
              "host_changed","level_up","augment_selected","shape_unlocked","shape_recognized",
              "countdown","game_over","advisor","shield_defense"}
        s_sp={"spell_result","augment_options","level_up_queued","room_created","room_joined",
              "room_error","connected","reconnected","error"}
        unsp=set(final.keys())-(b_sp|s_sp)
        print(f"\n[routing-spec] 미정의={unsp or '없음(준수)'}")

        # 콘솔 오류
        errs=[l for l in logs if "[error]" in l]
        print(f"\n[콘솔오류 {len(errs)}개]")
        for l in errs[:8]: print(f"  {l}")
        if not errs: print("  없음")

        pg.screenshot(path="/tmp/qa_full_final.png")
        br.close()

finally:
    srv.terminate(); srv.wait(timeout=5)

print(f"\n=== 서버 로그 요약 ({len(server_lines)}줄) ===")
for l in server_lines: print(f"  {l}")
print("\n완료")
