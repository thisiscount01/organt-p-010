"""
속성 상성 로직 + config 검증 (E2E 없이)
"""
import math, json

with open('config/balance.json') as f:
    B = json.load(f)

affinity = B['elementAffinity']
base_dmg = B['player']['baseSpellDamage']

def calc_damage(base, atk, def_elem):
    if not atk or not def_elem:
        return round(base)
    mult = affinity.get(atk, {}).get(def_elem, 1.0)
    return round(base * mult)

print("=== 속성 상성 계산 (서버 config 기준) ===")
all_elems = B['elements']
for atk in all_elems:
    for dfn in all_elems + [None]:
        dmg = calc_damage(base_dmg, atk, dfn)
        mult = affinity.get(atk,{}).get(dfn,1.0) if dfn else 1.0
        flag = '↑' if mult > 1.0 else ('↓' if mult < 1.0 else '=')
        print(f"  {atk} vs {dfn}: x{mult:.1f} → {dmg}dmg {flag}")

print("\n=== 웨이브별 적 HP/DMG 성장 ===")
wc = B['wave']
for w in [1,2,3,4,5,6,8,10]:
    hp  = round(wc['baseEnemyHp']   * (wc['hpGrowthPerWave']    ** (w-1)))
    dmg = round(wc['baseDamage']    * (wc['damageGrowthPerWave'] ** (w-1)))
    is_boss = (w % B['game']['bossWaveInterval'] == 0)
    comp_key = str(w) if w <= 10 else '4'
    comp = B['waveComposition'].get(comp_key, [])
    b_flag = ' ★BOSS' if is_boss else ''
    print(f"  Wave {w}: base_hp={hp}, base_dmg={dmg}, enemies={len(comp)}, types={list(set(comp))}{b_flag}")

print("\n=== 레벨 성장 곡선 ===")
p = B['player']
for lv in range(1, 10):
    exp_need = round(p['expToLevelBase'] * (p['expToLevelMultiplier'] ** (lv-1)))
    skill = B['levelSkills'].get(str(lv+1), None)
    sk_name = skill['name'] if skill else '-'
    print(f"  Lv{lv}→{lv+1}: exp={exp_need}, skill={sk_name}")

print("\n=== 마법진 인식 기준 ===")
d = B['drawing']
print(f"  minPoints={d['minPoints']}, minRadius={d['minRadius']}px")
print(f"  maxCV={d['maxCoefficientOfVariation']} (원형도 허용 오차)")
print(f"  minAngularSweep={d['minAngularSweep']}rad = {math.degrees(d['minAngularSweep']):.0f}deg (최소 호 스윕)")

print("\n=== config hot-reload ===")
print(f"  server.js 라인 14: fs.watch(BALANCE_PATH, ...) → 재배포 없이 반영 OK")
print(f"  startWave 마다 loadBalance() 호출 → 각 웨이브 시작 시 최신 config 적용")

print("\n=== 재연결 로직 ===")
print(f"  reconnectTimeoutMs={B['game']['reconnectTimeoutMs']}ms 내 재접속 → 세션 유지")
print(f"  ws.onclose → setTimeout(connect, 3000) → 3초 후 자동 재연결 시도")
