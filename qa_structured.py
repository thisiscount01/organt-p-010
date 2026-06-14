"""
Goal 1~7 구조화 QA
"""
import time, math, json, sys
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

R = {}  # results dict

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, args=['--no-sandbox'])
    ctx1 = browser.new_context(viewport={'width':1280,'height':800})
    ctx2 = browser.new_context(viewport={'width':1280,'height':800})
    p1, p2 = ctx1.new_page(), ctx2.new_page()

    ws1_times, ws1_msgs = [], []
    def on_ws(ws):
        def on_f(m):
            ws1_times.append(time.time())
            ws1_msgs.append(str(m))
        ws.on('framereceived', on_f)
    p1.on('websocket', on_ws)

    # 2인 접속
    p1.goto(BASE, wait_until='domcontentloaded'); time.sleep(0.5)
    p2.goto(BASE, wait_until='domcontentloaded'); time.sleep(0.5)
    wait_cond(p1, "()=>!document.getElementById('select-screen').classList.contains('hidden')", 'P1 select')
    wait_cond(p2, "()=>!document.getElementById('select-screen').classList.contains('hidden')", 'P2 select')
    R['both_connected'] = True

    # 속성 선택
    p1.locator('[data-el="fire"]').click();  time.sleep(0.3)
    p2.locator('[data-el="water"]').click(); time.sleep(0.3)
    wait_cond(p1, "()=>!document.getElementById('game-hud').classList.contains('hidden')", 'HUD', 10)
    wait_cond(p2, "()=>!document.getElementById('game-hud').classList.contains('hidden')", 'HUD P2', 10)

    R['p1_element'] = p1.evaluate("()=>document.getElementById('p1-eltag').textContent")
    R['p2_element'] = p2.evaluate("()=>document.getElementById('p2-eltag').textContent")
    R['wave_initial'] = p1.evaluate("()=>document.getElementById('wave-badge').textContent")
    R['p1_lv_initial'] = p1.evaluate("()=>document.getElementById('p1-lv').textContent")

    # 마법 발사 (Goal-5)
    pts = [{'x': 280+80*math.cos(i*2*math.pi/32), 'y': 350+80*math.sin(i*2*math.pi/32)} for i in range(32)]
    pts_js = json.dumps(pts)
    def cast(page):
        page.evaluate(f"()=>{{const p={pts_js};window.__sendWS({{type:'draw_start'}});for(const q of p)window.__sendWS({{type:'draw_point',x:q.x,y:q.y}});window.__sendWS({{type:'draw_end'}});}}")

    time.sleep(2)
    for _ in range(8):
        cast(p1); time.sleep(0.8)

    time.sleep(5)  # tick 수집

    # tick 분석
    if len(ws1_times) > 1:
        ivs = [(ws1_times[i+1]-ws1_times[i])*1000 for i in range(min(40,len(ws1_times)-1))]
        R['tick_avg_ms']  = round(sum(ivs)/len(ivs), 1)
        R['tick_max_ms']  = round(max(ivs), 1)
        R['tick_count']   = len(ws1_msgs)
    else:
        R['tick_avg_ms'] = R['tick_max_ms'] = R['tick_count'] = 0

    # 메시지 분류
    def count_type(t):
        return sum(1 for m in ws1_msgs if f'"type":"{t}"' in m)
    def find_type(t, n=3):
        found = [m for m in ws1_msgs if f'"type":"{t}"' in m]
        return found[:n]

    R['state_msgs']       = count_type('state')
    R['spell_result_ok']  = sum(1 for m in ws1_msgs if '"spell_result"' in m and '"success":true' in m)
    R['spell_result_fail']= sum(1 for m in ws1_msgs if '"spell_result"' in m and '"success":false' in m)
    R['hit_msgs']         = count_type('hit')
    R['enemy_die_msgs']   = count_type('enemy_die')
    R['wave_clear_msgs']  = count_type('wave_clear')
    R['wave_start_msgs']  = count_type('wave_start')
    R['boss_spawn_msgs']  = count_type('boss_spawn')
    R['advisor_msgs']     = count_type('advisor')
    R['level_up_msgs']    = count_type('level_up')

    # 샘플 메시지
    R['sample_spell_result'] = find_type('spell_result', 2)
    R['sample_hit']          = find_type('hit', 2)
    R['sample_advisor']      = find_type('advisor', 2)
    R['sample_level_up']     = find_type('level_up', 2)
    R['sample_wave']         = [m for m in ws1_msgs if 'wave_start' in m or 'wave_clear' in m][:3]

    R['score_after_spells']  = p1.evaluate("()=>parseInt(document.getElementById('score-val')?.textContent?.replace(/[^0-9]/g,''))||0")

    # 레벨업 유도 (Goal-4)
    for _ in range(30):
        cast(p1); cast(p2); time.sleep(0.5)
    time.sleep(3)

    R['p1_lv_final']    = p1.evaluate("()=>document.getElementById('p1-lv').textContent")
    R['p1_skills_html'] = p1.evaluate("()=>document.getElementById('p1-skills').innerHTML")
    R['wave_final']     = p1.evaluate("()=>document.getElementById('wave-badge').textContent")
    R['score_final']    = p1.evaluate("()=>document.getElementById('score-val').textContent")
    R['adv_hidden']     = p1.evaluate("()=>document.getElementById('advisor-panel').classList.contains('hidden')")
    R['adv_msg']        = p1.evaluate("()=>document.getElementById('adv-msg').textContent")

    R['level_up_total']    = count_type('level_up')
    R['advisor_total']     = count_type('advisor')
    R['boss_total']        = count_type('boss_spawn')
    R['wave_total']        = count_type('wave_start')
    R['sample_lv2']        = find_type('level_up', 3)
    R['sample_adv2']       = find_type('advisor', 3)
    R['sample_wave2']      = [m for m in ws1_msgs if 'wave_start' in m][:4]

    # 속성상성 검증: state 메시지에서 hit damage 추출
    hit_samples = find_type('hit', 5)
    R['hit_samples'] = hit_samples

    # 재연결 (Goal-1)
    p1.evaluate("()=>{ if(window.ws) window.ws.close(); }")
    time.sleep(4)
    R['disc_badge_hidden'] = p1.evaluate("()=>document.getElementById('p1-disc').classList.contains('hidden')")
    R['wave_after_recon']  = p1.evaluate("()=>document.getElementById('wave-badge').textContent")

    browser.close()

# 출력
print("=== QA STRUCTURED RESULTS ===")
for k, v in R.items():
    if isinstance(v, list):
        print(f"  {k}: ({len(v)} items)")
        for i, item in enumerate(v[:3]):
            trimmed = str(item)[:200]
            print(f"    [{i}] {trimmed}")
    else:
        print(f"  {k}: {v}")
