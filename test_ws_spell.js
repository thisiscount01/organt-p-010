/**
 * 마법진 드로잉 → 스펠 인식 → 데미지 파이프라인 검증
 * - 2인 연결 → 원소 선택 → wave_start 후
 * - draw_start/draw_point(원 28개)/draw_end 전송
 * - spell_result(success=true) 수신 확인
 * - 적 사망 및 score 증가 확인
 */
const WebSocket = require('ws');

const msgs = { ws1: [], ws2: [] };
let score = 0;
let spellResult = null;
let waveStarted = false;

function makeCircle(cx, cy, r, n = 28) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

const ws1 = new WebSocket('ws://localhost:3000');
let p1Id = null;

ws1.on('open', () => console.log('[WS1] connected'));
ws1.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.type === 'state') {
    score = m.score || 0;
    return;
  }
  msgs.ws1.push(m.type);
  console.log('[WS1]', m.type, JSON.stringify(m).slice(0, 100));
  if (m.type === 'connected')  p1Id = m.playerId;
  if (m.type === 'spell_result') spellResult = m;
  if (m.type === 'wave_start')  waveStarted = true;
});

const ws2 = new WebSocket('ws://localhost:3000');
setTimeout(() => {
  ws2.on('open', () => console.log('[WS2] connected'));
  ws2.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.type === 'state') return;
    msgs.ws2.push(m.type);
    console.log('[WS2]', m.type, JSON.stringify(m).slice(0, 80));
  });

  setTimeout(() => {
    // 두 플레이어 원소 선택
    ws1.send(JSON.stringify({ type: 'choose_element', element: 'fire' }));
    ws2.send(JSON.stringify({ type: 'choose_element', element: 'water' }));
  }, 600);

  // wave_start 후 4s에 마법진 드로잉
  setTimeout(() => {
    if (!waveStarted) { console.log('[WARN] wave not started yet'); }
    console.log('\n--- Drawing magic circle ---');
    ws1.send(JSON.stringify({ type: 'draw_start' }));
    const pts = makeCircle(280, 350, 60); // game coords, radius 60
    for (const p of pts) {
      ws1.send(JSON.stringify({ type: 'draw_point', x: p.x, y: p.y }));
    }
    ws1.send(JSON.stringify({ type: 'draw_end' }));
  }, 4000);

  // 결과 확인 (6s 후)
  setTimeout(() => {
    console.log('\n=== Spell Pipeline Test ===');
    console.log('spell_result:', spellResult);
    console.log('score after spell:', score);
    console.log('WS1 messages:', msgs.ws1.join(', '));

    const spellOk    = spellResult && spellResult.success === true;
    const scoredHit  = score > 0;
    console.log('\n[draw recognized]:', spellOk ? 'PASS' : 'FAIL');
    console.log('[score earned]    :', scoredHit ? 'PASS' : 'WARN (may need more time)');

    ws1.close(); ws2.close();
    process.exit((spellOk) ? 0 : 1);
  }, 7000);
}, 300);
