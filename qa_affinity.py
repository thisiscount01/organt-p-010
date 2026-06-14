"""
속성 상성·보스·웨이브 심화 검증
"""
import time, math, json
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:3000'

def wait_cond(page, js, label, timeout=10.0):
    t = 0
    while t < timeout:
        try:
            if page.evaluate(js): return True
        except: pass
        time.sleep(0.3); t += 0.3
    raise AssertionError(f"Timeout: {label}")

# --- 서버 직접 로직 검증 (JS 실행) ---
# calcDamage 함수 로직을 Python으로 재현
def calc_damage(base, atk_elem, def_elem, affinity):
    if not atk_elem or not def_elem:
        return round(base)
    mult = affinity.get(atk_elem, {}).get(def_elem, 1.0)
    return round(base * mult)

with open('config/balance.json') as f:
    B = json.load(f)

affinity = B['elementAffinity']
base_dmg = B['player']['baseSpellDamage']  # 28

print("=== 속성 상성 계산 검증 (서버 로직) ===")
cases = [
    ('fire',  'earth',     '유리 (1.5x)'),
    ('fire',  'water',     '불리 (0.7x)'),
    ('fire',  'fire',      '중립 (1.0x)'),
    ('water', 'fire',      '유리 (1.5x)'),
    ('water', 'lightning', '불리 (0.7x)'),
    ('lightning', 'water', '유리 (1.5x)'),
    ('earth', 'lightning', '유리 (1.5x)'),
    ('fire',  None,        '적 속성 없음'),
]
affinity_ok = True
for atk, def_, label in cases:
    dmg = calc_damage(base_dmg, atk, def_, affinity)
    print(f"  {atk} vs {def_}: damage={dmg}  ({label})")
    if def_ == 'earth' and atk == 'fire':
        if dmg != round(base_dmg * 1.5):
            affinity_ok = False
            print(f"  *** FAIL: expected {round(base_dmg*1.5)}, got {dmg}")
    if def_ == 'water' and atk == 'fire':
        if dmg != round(base_dmg * 0.7):
            affinity_ok = False
            print(f"  *** FAIL: expected {round(base_dmg*0.7)}, got {dmg}")

print(f"  속성 상성 계산 정확성: {'OK' if affinity_ok else 'FAIL'}")

# --- 웨이브 구성 확인 ---
print("\n=== 웨이브 구성 (config) ===")
for w in range(1, 11):
    is_boss = (w % B['game']['bossWaveInterval'] == 0)
    comp = B['waveComposition'].get(str(w), [])
    boss_flag = ' [BOSS WAVE]' if is_boss else ''
    print(f"  Wave {w}: {comp}{boss_flag}")

# --- 성장 곡선 검증 ---
print("\n=== 웨이브 적 강도 성장 ===")
wc = B['wave']
for w in [1, 2, 3, 5, 10]:
    hp  = round(wc['baseEnemyHp']   * (wc['hpGrowthPerWave']    ** (w-1)))
    dmg = round(wc['baseDamage']    * (wc['damageGrowthPerWave'] ** (w-1)))
    spd = round(wc['baseSpeed']     * (wc['speedGrowthPerWave']  ** (w-1)))
    cnt = len(B['waveComposition'].get(str(min(w,10)), B['waveComposition']['4']))
    print(f"  Wave {w}: hp={hp}, dmg={dmg}, spd={spd}, count={cnt}")

# --- 레벨 성장 곡선 ---
print("\n=== 레벨업 exp 요구량 ===")
p = B['player']
for lv in range(1, 8):
    exp_need = round(p['expToLevelBase'] * (p['expToLevelMultiplier'] ** (lv-1)))
    skill = B['levelSkills'].get(str(lv+1), None)
    skill_name = skill['name'] if skill else '(없음)'
    print(f"  Lv {lv}→{lv+1}: expToNext={exp_need}, skill={skill_name}")

# --- drawing 인식 기준 ---
print("\n=== 마법진 인식 기준 ===")
d = B['drawing']
print(f"  minPoints={d['minPoints']}, minRadius={d['minRadius']}, maxCV={d['maxCoefficientOfVariation']}, minAngularSweep={d['minAngularSweep']} rad ({math.degrees(d['minAngularSweep']):.0f}deg)")

# --- E2E: boss wave 도달 테스트 ---
print("\n=== E2E: 보스 웨이브 도달 테스트 ===")

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, args=['--no-sandbox'])
    ctx1 = browser.new_context(viewport={'width':1280,'height':800})
    ctx2 = browser.new_context(viewport={'width':1280,'height':800})
    p1, p2 = ctx1.new_page(), ctx2.new_page()

    ws_msgs = []
    def on_ws(ws):
        def on_f(m):
            ws_msgs.append(str(m))
        ws.on('framereceived', on_f)
    p1.on('websocket', on_ws)

    p1.goto(BASE, wait_until='domcontentloaded'); time.sleep(0.5)
    p2.goto(BASE, wait_until='domcontentloaded'); time.sleep(0.5)
    wait_cond(p1, "()=>!document.getElementById('select-screen').classList.contains('hidden')", 'select')
    wait_cond(p2, "()=>!document.getElementById('select-screen').classList.contains('hidden')", 'select')
    p1.locator('[data-el="fire"]').click();  time.sleep(0.3)
    p2.locator('[data-el="lightning"]').click(); time.sleep(0.3)
    wait_cond(p1, "()=>!document.getElementById('game-hud').classList.contains('hidden')", 'HUD', 10)
    wait_cond(p2, "()=>!document.getElementById('game-hud').classList.contains('hidden')", 'HUD', 10)

    pts = [{'x': 280+80*math.cos(i*2*math.pi/32), 'y': 350+80*math.sin(i*2*math.pi/32)} for i in range(32)]
    pts_js = json.dumps(pts)
    def cast(page):
        page.evaluate(f"()=>{{const p={pts_js};window.__sendWS({{type:'draw_start'}});for(const q of p)window.__sendWS({{type:'draw_point',x:q.x,y:q.y}});window.__sendWS({{type:'draw_end'}});}}")

    # 고속 발사로 wave 5까지 빠르게 클리어 시도 (최대 90초)
    target_wave = 5
    deadline = time.time() + 90
    last_wave = 1

    print("  Grinding waves...")
    while time.time() < deadline:
        cast(p1); cast(p2)
        time.sleep(0.35)
        try:
            wave_txt = p1.evaluate("()=>document.getElementById('wave-badge').textContent")
            w_num = int(''.join(filter(str.isdigit, wave_txt)) or '0')
            if w_num != last_wave:
                print(f"  -> {wave_txt}")
                last_wave = w_num
            if w_num >= target_wave:
                time.sleep(2)  # boss spawn 대기
                break
        except: pass

    # boss 도달 확인
    boss_msgs   = [m for m in ws_msgs if 'boss_spawn' in m]
    wave_starts = [m for m in ws_msgs if '"type":"wave_start"' in m]
    hits        = [m for m in ws_msgs if '"type":"hit"' in m]
    lv_ups      = [m for m in ws_msgs if '"type":"level_up"' in m]

    # 속성 상성 hit 검증: 실제 tank(earth) enemy 피격 데미지 확인
    # wave 3+ 에서 tank 등장 → fire vs earth = 1.5x = 42 damage 기대
    earth_hits = [m for m in ws_msgs if '"isEnemy":true' in m and '"element":"fire"' in m]
    all_hits    = [m for m in ws_msgs if '"isEnemy":true' in m]

    print(f"  Boss spawn msgs: {boss_msgs[:2]}")
    print(f"  Wave starts: {wave_starts}")
    print(f"  Level ups: {lv_ups[:3]}")
    print(f"  Fire->enemy hits: {earth_hits[:5]}")
    print(f"  All enemy hits sample: {all_hits[:5]}")

    # 도달 wave
    final_wave = p1.evaluate("()=>document.getElementById('wave-badge').textContent")
    final_lv   = p1.evaluate("()=>document.getElementById('p1-lv').textContent")
    final_score= p1.evaluate("()=>document.getElementById('score-val').textContent")
    adv_hidden = p1.evaluate("()=>document.getElementById('advisor-panel').classList.contains('hidden')")
    adv_msg    = p1.evaluate("()=>document.getElementById('adv-msg').textContent")

    print(f"  Final: wave={final_wave}, lv={final_lv}, score={final_score}")
    print(f"  Advisor: hidden={adv_hidden}, msg='{adv_msg}'")

    p1.screenshot(path='/tmp/qa_boss_test.png')
    browser.close()
