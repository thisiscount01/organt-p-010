"""QA 빠른 검증 — 60s 이내"""
from playwright.sync_api import sync_playwright
import json, time, math

LOCAL = "http://localhost:3000"
WS_INTERCEPT = """
window.__wsLog = [];
window.__wsSent = [];
const _OWS = window.WebSocket;
window.WebSocket = function(...a) {
    const ws = new _OWS(...a);
    ws.addEventListener('message', e => { try { window.__wsLog.push(JSON.parse(e.data)); } catch {} });
    const os = ws.send.bind(ws);
    ws.send = d => { try { window.__wsSent.push(JSON.parse(d)); } catch {}; return os(d); };
    return ws;
};
"""

def evs(page): return page.evaluate("window.__wsLog||[]")
def cnt(page):
    c={}
    for e in evs(page): t=e.get("type","?"); c[t]=c.get(t,0)+1
    return c

def draw_circle(page, cx, cy, r=65, steps=28):
    page.mouse.move(cx+r, cy)
    page.mouse.down()
    for i in range(1, steps+1):
        a = (i/steps)*2*math.pi
        page.mouse.move(cx+r*math.cos(a), cy+r*math.sin(a))
        page.wait_for_timeout(5)
    page.mouse.up()

with sync_playwright() as p:
    br = p.chromium.launch(headless=True, args=["--no-sandbox"])
    ctx = br.new_context(viewport={"width":1280,"height":800})
    ctx.add_init_script(WS_INTERCEPT)
    pg = ctx.new_page()
    logs = []
    pg.on("console", lambda m: logs.append(f"[{m.type}] {m.text[:200]}"))

    # 1. 로드
    pg.goto(LOCAL, timeout=10000, wait_until="domcontentloaded")
    pg.wait_for_timeout(2000)
    canvas = pg.query_selector("canvas")
    print(f"캔버스: {'있음' if canvas else '없음'}")
    print(f"초기 WS: {list(cnt(pg).keys())}")

    # 2. 방 만들기
    b = pg.query_selector("button:has-text('방 만들기')")
    if b: b.click(); pg.wait_for_timeout(1500)
    print(f"방 생성 후 WS: {list(cnt(pg).keys())}")

    # 3. 게임 시작
    sb = pg.evaluate_handle("()=>Array.from(document.querySelectorAll('button')).find(b=>b.offsetParent!==null&&b.textContent.includes('시작'))")
    try:
        sb.as_element().click(); pg.wait_for_timeout(6500)
    except Exception as e:
        print(f"시작 실패: {e}")

    c0 = cnt(pg)
    print(f"\n[게임시작 후 이벤트] {c0}")

    # 4. 원 그리기 10회
    box = canvas.bounding_box() if canvas else None
    if box:
        cx = box['x']+box['width']//2; cy = box['y']+box['height']//2
        for _ in range(10):
            draw_circle(pg, cx, cy)
            pg.wait_for_timeout(400)

    pg.wait_for_timeout(5000)
    c1 = cnt(pg)
    print(f"\n[10회 주문 후 이벤트] {c1}")

    # 5. 10초 추가 대기 (적 행동 포착)
    if box:
        for _ in range(4):
            draw_circle(pg, cx, cy)
            pg.wait_for_timeout(600)
    pg.wait_for_timeout(6000)

    all_c = cnt(pg)
    all_evs = evs(pg)

    print(f"\n=== 최종 이벤트 카운트 ===")
    for k,v in sorted(all_c.items()):
        print(f"  {k}: {v}")

    # 핵심 이벤트 샘플
    print("\n=== 핵심 이벤트 샘플 ===")
    for et in ["co_combo_hit","elemental_surge","shield_defense","enemy_heal","wave_start",
               "spell_cast","spell_result","shape_recognized","connected","room_created","state"]:
        s = next((e for e in all_evs if e.get("type")==et), None)
        if s: print(f"  [{et}] {json.dumps(s,ensure_ascii=False)[:350]}")

    # routing-spec 확인
    b_spec={"state","wave_start","wave_clear","wave_prep","enemy_spawn","enemy_die","enemy_heal",
            "hit","co_combo_hit","spell_cast","attack_anim","boss_spawn","player_die","player_revive",
            "player_disconnect","player_joined","player_left","host_changed","level_up","augment_selected",
            "shape_unlocked","shape_recognized","countdown","game_over","advisor","shield_defense"}
    s_spec={"spell_result","augment_options","level_up_queued","room_created","room_joined",
            "room_error","connected","reconnected","error"}
    unspec = set(all_c.keys())-(b_spec|s_spec)
    print(f"\n[routing-spec] 미정의: {unspec if unspec else '없음'}")

    # 엣지케이스: 연속 입력
    print("\n=== 엣지케이스: 빠른 연속 입력 ===")
    if box:
        for _ in range(8):
            draw_circle(pg, cx, cy, r=65, steps=15)
            pg.wait_for_timeout(50)
    pg.wait_for_timeout(1000)
    c2 = cnt(pg)
    new_spell = c2.get("spell_cast",0) - all_c.get("spell_cast",0)
    new_fail  = c2.get("spell_result",0) - all_c.get("spell_result",0)
    print(f"  8회 급속 입력 → spell_cast+{new_spell}, spell_result+{new_fail}")

    # 오류
    errs = [l for l in logs if "[error]" in l]
    print(f"\n=== 콘솔 오류 ({len(errs)}개) ===")
    for l in errs[:8]: print(f"  {l}")
    if not errs: print("  없음")

    pg.screenshot(path="/tmp/qa_fast_final.png")
    br.close()
    print("\n완료")
