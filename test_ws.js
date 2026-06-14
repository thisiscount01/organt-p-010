/**
 * WebSocket 2인 연결 흐름 진단 스크립트
 */
const WebSocket = require('ws');

const msgs1 = [], msgs2 = [];

const ws1 = new WebSocket('ws://localhost:3000');
ws1.on('open',    ()  => console.log('[WS1] connected'));
ws1.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.type !== 'state') { // state는 너무 많으니 skip
    msgs1.push(m.type);
    console.log('[WS1]', m.type, JSON.stringify(m).slice(0, 120));
  }
});
ws1.on('error', e => console.error('[WS1 error]', e.message));

setTimeout(() => {
  const ws2 = new WebSocket('ws://localhost:3000');
  ws2.on('open',    ()  => console.log('[WS2] connected'));
  ws2.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.type !== 'state') {
      msgs2.push(m.type);
      console.log('[WS2]', m.type, JSON.stringify(m).slice(0, 120));
    }
  });
  ws2.on('error', e => console.error('[WS2 error]', e.message));

  // After both connect, choose elements
  setTimeout(() => {
    console.log('\n--- Choosing elements ---');
    ws1.send(JSON.stringify({ type: 'choose_element', element: 'fire' }));
    ws2.send(JSON.stringify({ type: 'choose_element', element: 'water' }));
  }, 800);

  // After game starts, wait for wave_start
  setTimeout(() => {
    console.log('\n=== WS1 messages:', msgs1.join(', '));
    console.log('=== WS2 messages:', msgs2.join(', '));
    const ok = msgs1.includes('wave_start') && msgs2.includes('wave_start');
    console.log('\nResult:', ok ? 'PASS — wave_start received' : 'FAIL — wave_start not received');
    ws1.close(); ws2.close();
    process.exit(ok ? 0 : 1);
  }, 6000);
}, 300);
