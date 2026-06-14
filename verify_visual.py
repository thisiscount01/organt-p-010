"""시각적 최종 검증"""
import math, time
from playwright.sync_api import sync_playwright

def make_circle(cx, cy, r, n=30):
    return [(cx+math.cos(i/n*2*math.pi)*r, cy+math.sin(i/n*2*math.pi)*r) for i in range(n+1)]

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--no-sandbox'])
    page = browser.new_context(viewport={'width':1280,'height':800}).new_page()

    page.goto('http://localhost:3000/', wait_until='networkidle')
    time.sleep(1)

    # 방 생성 → 시작
    page.click('#btn-create')
    time.sleep(0.7)
    page.click('#btn-start')
    page.wait_for_selector('#game-hud:not(.hidden)', timeout=10000)
    time.sleep(3.5)

    # 원 그리기 (spell overlay 트리거)
    canvas = page.query_selector('#draw-canvas')
    b = canvas.bounding_box()
    cx,cy,r = b['x']+b['width']/2, b['y']+b['height']/2, min(b['width'],b['height'])*0.14

    page.mouse.move(cx+r, cy)
    page.mouse.down()
    for (px,py) in make_circle(cx,cy,r):
        page.mouse.move(px,py)
    page.mouse.up()

    time.sleep(0.08)
    page.screenshot(path='final_recognizing.png')
    print('SS1: recognizing overlay captured')

    time.sleep(0.6)
    page.screenshot(path='final_spellname.png')
    name_text = page.eval_on_selector('#spell-overlay-name', 'el => el.textContent')
    print(f'SS2: spell name = "{name_text}"')

    # 게임 오버 대기
    try:
        page.wait_for_selector('#gameover-screen:not(.hidden)', timeout=60000)
        time.sleep(1.5)
        page.screenshot(path='final_gameover.png')
        kills = page.eval_on_selector('#over-kills', 'el => el.textContent')
        combo = page.eval_on_selector('#over-combo', 'el => el.textContent')
        lb    = page.eval_on_selector('#leaderboard-section', 'el => el.style.display')
        print(f'SS3: game over kills={kills} combo={combo} lb_display={lb}')
    except Exception as e:
        print(f'SS3: timeout ({e})')

    browser.close()
print("DONE")
