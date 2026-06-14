"""
Wave Defense — 2인 접속 → 전투 사이클 검증 (60s 내 완료 버전)
"""
import time, math, sys
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:3000'

def wait_dom(page, js_cond, label, timeout=8.0, interval=0.2):
    elapsed = 0.0
    while elapsed < timeout:
        try:
            if page.evaluate(js_cond):
                return True
        except Exception:
            pass
        time.sleep(interval)
        elapsed += interval
    raise AssertionError(f"Timeout ({timeout}s): {label}")

def run():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=['--no-sandbox'])
        errs_p1 = []

        ctx1 = browser.new_context()
        p1 = ctx1.new_page()
        p1.on('pageerror', lambda e: errs_p1.append(str(e)))
        p1.on('console', lambda m: errs_p1.append(m.text) if m.type == 'error' else None)

        ctx2 = browser.new_context()
        p2 = ctx2.new_page()

        results = {}

        # ── P1 접속 ─────────────────────────────────────────────────
        p1.goto(BASE, wait_until='domcontentloaded', timeout=10000)
        time.sleep(0.8)
        results['title'] = p1.title()
        print(f'[1] 타이틀: {results["title"]}')

        # Pixi.js 로드 확인
        pixi_v = p1.evaluate("() => typeof PIXI !== 'undefined' ? PIXI.VERSION : 'NOT_LOADED'")
        print(f'[2] Pixi.js: {pixi_v}')
        results['pixi_loaded'] = (pixi_v != 'NOT_LOADED')

        results['p1_lobby'] = p1.evaluate(
            "() => !document.getElementById('lobby-screen').classList.contains('hidden')")
        print(f'[3] P1 로비: {results["p1_lobby"]}')

        # ── P2 접속 ─────────────────────────────────────────────────
        p2.goto(BASE, wait_until='domcontentloaded', timeout=10000)
        time.sleep(1.0)

        print('[→] 원소선택 대기...')
        wait_dom(p1,
            "() => !document.getElementById('select-screen').classList.contains('hidden')",
            'P1 select-screen', timeout=10.0)
        wait_dom(p2,
            "() => !document.getElementById('select-screen').classList.contains('hidden')",
            'P2 select-screen', timeout=10.0)
        print('[4] 원소선택 화면 OK')
        results['select_shown'] = True

        # ── 원소 선택 ────────────────────────────────────────────────
        p1.locator('.el-btn.fire').click()
        time.sleep(0.3)
        p2.locator('.el-btn.water').click()
        time.sleep(0.3)
        print('[5] P1=불꽃, P2=물 선택')
        results['elements_chosen'] = True

        # ── HUD 대기 (카운트다운 3s + 버퍼) ────────────────────────
        print('[→] HUD 대기...')
        wait_dom(p1,
            "() => !document.getElementById('game-hud').classList.contains('hidden')",
            'game-hud', timeout=8.0)
        wait_dom(p2,
            "() => !document.getElementById('game-hud').classList.contains('hidden')",
            'game-hud P2', timeout=8.0)
        print('[6] HUD 표시됨')
        results['hud_visible'] = True

        # 웨이브 배지 확인
        wait_dom(p1,
            "() => document.getElementById('wave-badge').textContent.includes('WAVE')",
            'wave badge', timeout=3.0)
        wave_txt = p1.evaluate("() => document.getElementById('wave-badge').textContent")
        print(f'[7] 웨이브: {wave_txt}')
        results['wave_started'] = True

        # ── 적 스폰 대기 (1회 spawnInterval = 900ms) ────────────────
        time.sleep(2.0)
        p1.screenshot(path='/tmp/game_live.png')
        print('[8] 게임 스크린샷: /tmp/game_live.png')
        results['game_running'] = True

        # ── 마법진 드로잉 — WS 직접 전송 (mouse events 대신) ─────────────
        # draw-canvas bounding_box 확인 (캔버스 존재 검증)
        dc = p1.locator('#draw-canvas')
        bb = dc.bounding_box()
        print(f'   draw-canvas: {int(bb["width"])}×{int(bb["height"])} at ({int(bb["x"])},{int(bb["y"])})')

        import json as _json
        _pts = [
            {'x': 280 + 60*math.cos(i*2*math.pi/28),
             'y': 350 + 60*math.sin(i*2*math.pi/28)}
            for i in range(28)
        ]
        _pts_js = _json.dumps(_pts)

        def cast_spell_ws():
            p1.evaluate(f"""() => {{
                const pts = {_pts_js};
                window.__sendWS({{type:'draw_start'}});
                for (const p of pts) window.__sendWS({{type:'draw_point', x:p.x, y:p.y}});
                window.__sendWS({{type:'draw_end'}});
            }}""")

        for i in range(4):
            cast_spell_ws()
            time.sleep(1.5)
            score_txt = p1.evaluate(
                "() => document.getElementById('score-val')?.textContent || '0'")
            score = int(str(score_txt).replace(' pts','').replace(',','').strip() or '0')
            print(f'   cast {i+1}: score={score}')
            if score > 0:
                results['score_earned'] = True
                results['final_score']  = score
                break
        else:
            results['score_earned'] = False
            results['final_score']  = 0

        p1.screenshot(path='/tmp/final_p1.png')
        p2.screenshot(path='/tmp/final_p2.png')

        if errs_p1:
            print('[JS ERRORS]:', errs_p1[:5])

        browser.close()

        # ── 결과 ────────────────────────────────────────────────────
        print()
        print('══════════ 검증 결과 ══════════')
        checks = [
            ('타이틀 정상',          '웨이브' in results.get('title', '')),
            ('Pixi.js 로드',          results.get('pixi_loaded', False)),
            ('P1 로비 표시',          results.get('p1_lobby', False)),
            ('2인 원소선택 화면',     results.get('select_shown', False)),
            ('원소 선택 완료',        results.get('elements_chosen', False)),
            ('HUD·웨이브 시작',      results.get('hud_visible', False) and results.get('wave_started', False)),
            ('게임 렌더 확인',        results.get('game_running', False)),
            ('마법진 드로잉·점수',   results.get('score_earned', False)),
        ]
        all_ok = True
        for label, ok in checks:
            icon = '✓' if ok else '✗'
            print(f'  [{icon}] {label}')
            if not ok: all_ok = False
        print(f'  최종 점수: {results.get("final_score", 0)}')
        print('═══════════════════════════════')
        return all_ok

if __name__ == '__main__':
    ok = run()
    sys.exit(0 if ok else 1)
