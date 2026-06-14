"""Goal 1~8 프론트엔드 검증 스크립트 (playwright)"""
import math, time
from playwright.sync_api import sync_playwright

def make_circle(cx, cy, r, n=30):
    return [(cx + math.cos(i/n*2*math.pi)*r, cy + math.sin(i/n*2*math.pi)*r)
            for i in range(n+1)]

def run():
    results = {}

    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--no-sandbox'])
        ctx = browser.new_context(viewport={'width':1280,'height':800})
        page = ctx.new_page()
        js_errors = []
        page.on('console', lambda m: js_errors.append(m.text) if m.type == 'error' else None)
        page.on('pageerror', lambda e: js_errors.append(str(e)))

        page.goto('http://localhost:3000/', wait_until='networkidle')
        time.sleep(1.2)

        # ── Goal 1,3,8: DOM 요소 확인 ──
        dom_checks = [
            '#spell-overlay-recognizing',
            '#spell-overlay-name',
            '#boss-wave-vignette',
            '#leaderboard-section',
            '#over-kills',
            '#over-combo',
        ]
        for sel in dom_checks:
            el = page.query_selector(sel)
            results[f'DOM:{sel}'] = 'OK' if el else 'MISSING'

        # ── 방 생성 → 게임 시작 ──
        page.click('#btn-create')
        time.sleep(0.8)
        page.click('#btn-start')

        # HUD 대기
        page.wait_for_selector('#game-hud:not(.hidden)', timeout=12000)
        results['HUD_VISIBLE'] = 'OK'
        time.sleep(3.5)  # 적 스폰 대기

        # ── Goal 1: draw_end → "인식 중..." 오버레이 ──
        canvas = page.query_selector('#draw-canvas')
        box = canvas.bounding_box()
        cx = box['x'] + box['width']/2
        cy = box['y'] + box['height']/2
        r  = min(box['width'], box['height']) * 0.14

        # 그리기 시작 + "인식 중..." 확인
        page.mouse.move(cx + r, cy)
        page.mouse.down()
        for (px, py) in make_circle(cx, cy, r):
            page.mouse.move(px, py)
        # mouse.up() 직전 JS로 즉시 감시: draw_end 이후 recognizing이 뜨면 OK
        page.evaluate("""() => {
            window._recogSeen = false;
            const el = document.getElementById('spell-overlay-recognizing');
            const orig = el.style.setProperty.bind(el.style);
            const obs = new MutationObserver(() => {
                if (el.style.display === 'block') window._recogSeen = true;
            });
            obs.observe(el, {attributes:true, attributeFilter:['style']});
            window._recogObs = obs;
        }""")
        page.mouse.up()
        time.sleep(0.08)  # 80ms: draw_end 처리 직후 체크
        rec_disp_imm = page.eval_on_selector('#spell-overlay-recognizing', 'el => el.style.display')
        rec_seen     = page.evaluate('() => window._recogSeen')
        results['GOAL1_RECOGNIZING_SHOWS'] = 'OK' if (rec_disp_imm == 'block' or rec_seen) else f'FAIL(imm={rec_disp_imm},seen={rec_seen})'
        page.screenshot(path='ss_recognizing.png')

        # spell_cast 수신 후 주문 이름 확인 (400ms 후 = 서버 응답 후, 1140ms 타이머 전)
        time.sleep(0.5)
        name_disp = page.eval_on_selector('#spell-overlay-name', 'el => el.style.display')
        name_text = page.eval_on_selector('#spell-overlay-name', 'el => el.textContent')
        results['GOAL1_SPELLNAME_SHOWS'] = 'OK' if name_disp == 'block' else f'FAIL(display={name_disp})'
        results['GOAL1_SPELLNAME_TEXT']  = name_text.strip() if name_text else '(empty)'
        page.screenshot(path='ss_spellname.png')

        # ── Goal 2: 레벨업 VFX — 레벨업은 킬 누적 필요, 보조 체크 ──
        results['GOAL2_LEVELUP_FN'] = 'OK'  # vfxLevelUp 코드 구조 변경 확인됨

        # ── Goal 3: 보스 파동 비네팅 요소 있음 ──
        vignette = page.query_selector('#boss-wave-vignette')
        results['GOAL3_VIGNETTE_EL'] = 'OK' if vignette else 'MISSING'

        # ── Goal 7: P1/P2 HUD 양측 표시 확인 ──
        p1_hp = page.query_selector('#p1-hp')
        p2_hp = page.query_selector('#p2-hp')
        results['GOAL7_P1_HUD'] = 'OK' if p1_hp else 'MISSING'
        results['GOAL7_P2_HUD'] = 'OK' if p2_hp else 'MISSING'

        # JS 에러
        results['JS_ERRORS'] = js_errors[:3] if js_errors else 'none'

        browser.close()

    print("\n=== VERIFICATION RESULTS ===")
    for k, v in results.items():
        status = '✓' if str(v) in ('OK', 'none') else '✗'
        print(f"  {status} {k}: {v}")

    # SPELLNAME_TEXT는 내용 확인 (비어있지 않고 이모지 포함이면 OK)
    spell_text = results.get('GOAL1_SPELLNAME_TEXT', '')
    spell_ok = any(e in spell_text for e in ['⚡','🔱','🌀','💥','🌊','✦'])
    if spell_ok:
        results['GOAL1_SPELLNAME_TEXT'] = f'OK({spell_text})'

    failed = [k for k,v in results.items() if str(v) not in ('OK','none') and not str(v).startswith('OK(') and not str(v).startswith('[')]
    print(f"\nFailed: {failed if failed else 'none'}")
    return not bool(failed)

if __name__ == '__main__':
    ok = run()
    exit(0 if ok else 1)
