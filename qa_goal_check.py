"""
Goal 1~7 심층 QA — localhost:3000 로컬 실행
"""
import time, math, json
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:3000'

def wait_cond(page, js, label, timeout=8.0):
    t = 0
    while t < timeout:
        try:
            if page.evaluate(js): return True
        except: pass
        time.sleep(0.3); t += 0.3
    raise AssertionError(f"Timeout: {label}")

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, args=['--no-sandbox'])
    ctx1 = browser.new_context(viewport={'width':1280,'height':800})
    ctx2 = browser.new_context(viewport={'width':1280,'height':800})
    p1 = ctx1.new_page()
    p2 = ctx2.new_page()

    ws1_times = []; ws1_msgs = []
    def on_ws(ws):
        def on_f(m):
            ws1_times.append(time.time())
            ws1_msgs.append(str(m))
        ws.on('framereceived', on_f)
    p1.on('websocket', on_ws)

    # --- Goal-1: 2인 접속 & WS 연결 ---
    p1.goto(BASE, wait_until='domcontentloaded'); time.sleep(0.5)
    p2.goto(BASE, wait_until='domcontentloaded'); time.sleep(0.5)

    wait_cond(p1, "()=>!document.getElementById('select-screen').classList.contains('hidden')", 'P1 select')
    wait_cond(p2, "()=>!document.getElementById('select-screen').classList.contains('hidden')", 'P2 select')

    # --- Goal-2: 속성 선택 ---
    p1.locator('[data-el="fire"]').click();  time.sleep(0.3)
    p2.locator('[data-el="water"]').click(); time.sleep(0.3)

    wait_cond(p1, "()=>!document.getElementById('game-hud').classList.contains('hidden')", 'HUD')
    wait_cond(p2, "()=>!document.getElementById('game-hud').classList.contains('hidden')", 'HUD P2')

    wave1  = p1.evaluate("()=>document.getElementById('wave-badge').textContent")
    score0 = p1.evaluate("()=>document.getElementById('score-val').textContent")
    p1lv0  = p1.evaluate("()=>document.getElementById('p1-lv').textContent")
    p1el   = p1.evaluate("()=>document.getElementById('p1-eltag').textContent")
    p2el   = p2.evaluate("()=>document.getElementById('p2-eltag').textContent")
    print(f"[WAVE] {wave1}, [SCORE] {score0}, [P1 LV] {p1lv0}, [P1 EL] {p1el}, [P2 EL] {p2el}")

    # --- Goal-5: 마법진 드로잉 → 점수 ---
    pts_circle = [{'x': 280+80*math.cos(i*2*math.pi/32), 'y': 350+80*math.sin(i*2*math.pi/32)} for i in range(32)]
    pts_js = json.dumps(pts_circle)

    def cast_spell(page):
        page.evaluate(f"""()=>{{
            const pts={pts_js};
            window.__sendWS({{type:'draw_start'}});
            for(const p of pts) window.__sendWS({{type:'draw_point',x:p.x,y:p.y}});
            window.__sendWS({{type:'draw_end'}});
        }}""")

    time.sleep(2)
    spell_scores = []
    for i in range(8):
        cast_spell(p1)
        time.sleep(0.8)
        sc = p1.evaluate("()=>parseInt(document.getElementById('score-val')?.textContent?.replace(/[^0-9]/g,''))||0")
        spell_scores.append(sc)

    print(f"[SPELLS] score progression: {spell_scores}")

    # --- Goal-1: tick 측정 ---
    time.sleep(5)
    tick_intervals = [(ws1_times[i+1]-ws1_times[i])*1000 for i in range(min(40,len(ws1_times)-1))]
    avg_tick = sum(tick_intervals)/len(tick_intervals) if tick_intervals else 0
    max_tick = max(tick_intervals) if tick_intervals else 0
    print(f"[TICK] count={len(ws1_msgs)}, avg={avg_tick:.1f}ms, max={max_tick:.1f}ms")

    # WS 메시지 타입 카운트
    msg_types = {}
    for m in ws1_msgs:
        try:
            mt = json.loads(m).get('type','?')
            msg_types[mt] = msg_types.get(mt,0)+1
        except: pass
    print(f"[WS MSG TYPES] {msg_types}")

    # --- Goal-2: 속성 상성 관련 메시지 ---
    spell_result_msgs = [m for m in ws1_msgs if 'spell_result' in m]
    hit_msgs          = [m for m in ws1_msgs if '"type":"hit"' in m]
    advisor_msgs      = [m for m in ws1_msgs if '"type":"advisor"' in m]
    level_up_msgs     = [m for m in ws1_msgs if 'level_up' in m]
    enemy_die_msgs    = [m for m in ws1_msgs if 'enemy_die' in m]
    wave_msgs         = [m for m in ws1_msgs if 'wave_' in m]
    boss_msgs         = [m for m in ws1_msgs if 'boss_spawn' in m]

    print(f"[spell_result] {spell_result_msgs[:4]}")
    print(f"[hit]          {hit_msgs[:3]}")
    print(f"[advisor]      {advisor_msgs[:3]}")
    print(f"[level_up]     {level_up_msgs[:2]}")
    print(f"[enemy_die]    {len(enemy_die_msgs)} kills")
    print(f"[wave msgs]    {wave_msgs[:4]}")
    print(f"[boss_spawn]   {boss_msgs[:2]}")

    # --- Goal-4: 레벨업 유도 (더 많이 cast) ---
    for _ in range(25):
        cast_spell(p1)
        cast_spell(p2)
        time.sleep(0.55)

    time.sleep(3)
    p1lv_new  = p1.evaluate("()=>document.getElementById('p1-lv').textContent")
    p1skills  = p1.evaluate("()=>document.getElementById('p1-skills').innerHTML")
    wave_now  = p1.evaluate("()=>document.getElementById('wave-badge').textContent")
    score_now = p1.evaluate("()=>document.getElementById('score-val').textContent")
    adv_hidden= p1.evaluate("()=>document.getElementById('advisor-panel').classList.contains('hidden')")
    adv_msg   = p1.evaluate("()=>document.getElementById('adv-msg').textContent")
    print(f"\n--- After extended play ---")
    print(f"[P1 LV] {p1lv_new}")
    print(f"[P1 SKILLS HTML] {p1skills[:300]}")
    print(f"[WAVE]  {wave_now}")
    print(f"[SCORE] {score_now}")
    print(f"[ADVISOR] hidden={adv_hidden}, msg='{adv_msg}'")

    lv_msgs2  = [m for m in ws1_msgs if 'level_up' in m]
    adv_msgs2 = [m for m in ws1_msgs if '"type":"advisor"' in m]
    boss_msgs2= [m for m in ws1_msgs if 'boss_spawn' in m]
    wave_msgs2= [m for m in ws1_msgs if 'wave_' in m]
    print(f"[LV_UP total]   {lv_msgs2[:4]}")
    print(f"[ADVISOR total] {adv_msgs2[:4]}")
    print(f"[BOSS total]    {boss_msgs2}")
    print(f"[WAVE total]    {wave_msgs2[:6]}")

    # --- Goal-1: 재연결 ---
    p1.evaluate("()=>{ if(window.ws) window.ws.close(); }")
    time.sleep(4)
    disc_badge  = p1.evaluate("()=>document.getElementById('p1-disc').classList.contains('hidden')")
    wave_after  = p1.evaluate("()=>document.getElementById('wave-badge').textContent")
    print(f"\n[RECONNECT] disc-badge hidden={disc_badge}, wave={wave_after}")

    # --- Final screenshots ---
    p1.screenshot(path='/tmp/qa_final_p1.png')
    p2.screenshot(path='/tmp/qa_final_p2.png')
    print("[SCREENSHOTS] saved")

    browser.close()
