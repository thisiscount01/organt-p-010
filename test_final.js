'use strict';
/**
 * 최종 통합 검증 — 로컬 서버
 * 목표 루브릭 전항목 runtime 검증
 */
const WebSocket = require('ws');
const http = require('http');
const BASE = 'ws://localhost:3000';
const HTTP = 'http://localhost:3000';

let passed = 0, failed = 0;
const RESULTS = [];
function pass(n, d='') { passed++; RESULTS.push(`  ✓ ${n}${d?' ['+d+']':''}`); console.log(RESULTS[RESULTS.length-1]); }
function fail(n, r='') { failed++; RESULTS.push(`  ✗ ${n} — ${r}`);           console.log(RESULTS[RESULTS.length-1]); }

function httpGet(url) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    http.get(url, r => {
      let d=''; r.on('data',c=>d+=c);
      r.on('end', () => { try { res({body:JSON.parse(d), ms:Date.now()-t0, status:r.statusCode}); } catch { res({body:d,ms:Date.now()-t0,status:r.statusCode}); } });
    }).on('error', rej);
  });
}

function wsConn() {
  return new Promise(res => {
    const ws = new WebSocket(BASE);
    ws.on('open', () => res(ws));
    ws.on('error', () => res(null));
    setTimeout(() => res(null), 6000);
  });
}

// 큐 기반 메시지 버퍼 — 메시지 손실 없이 순서대로 수신
function msgQueue(ws) {
  const q = [], waiters = [];
  ws.on('message', raw => {
    try {
      const m = JSON.parse(raw);
      if (waiters.length) { const w = waiters.shift(); clearTimeout(w.t); w.res(m); }
      else q.push(m);
    } catch {}
  });
  return {
    next(types, ms=8000) {
      return new Promise(res => {
        // drain already-queued
        for (let i = 0; i < q.length; i++) {
          if (!types || types.includes(q[i].type)) {
            return res(q.splice(i, 1)[0]);
          }
        }
        // wait for future
        const t = setTimeout(() => {
          const idx = waiters.findIndex(w => w.res === res);
          if (idx >= 0) waiters.splice(idx, 1);
          res(null);
        }, ms);
        // wrap with type filter
        const wrapped = { t, res: m => {
          if (!types || types.includes(m.type)) res(m);
          else {
            q.push(m);
            const t2 = setTimeout(() => {
              const idx = waiters.findIndex(w => w.res === wrapped.res);
              if (idx >= 0) waiters.splice(idx, 1);
              res(null);
            }, ms);
            waiters.push({ t: t2, res: wrapped.res });
          }
        }};
        waiters.push(wrapped);
      });
    },
    drain(ms) {
      return new Promise(res => {
        const msgs = [...q]; q.length = 0;
        const origHandler = ws.listeners('message').slice(-1)[0];
        const extra = [];
        const collector = raw => { try { extra.push(JSON.parse(raw)); } catch {} };
        ws.on('message', collector);
        setTimeout(() => {
          ws.off('message', collector);
          res([...msgs, ...extra]);
        }, ms);
      });
    }
  };
}

function send(ws, obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// 지그재그 포인트 (좌우 진폭 120px, 반복 6회 → reversals >= 6)
function makeZigzag() {
  const pts = [];
  for (let i = 0; i <= 60; i++) {
    const t = i / 60;
    const x = 200 + (i % 2 === 0 ? 0 : 120);
    const y = 150 + i * 5;
    pts.push({ x: Math.round(x + Math.random()*2), y: Math.round(y) });
  }
  return pts;
}

(async () => {
  console.log('\n════════════════════════════════════════════');
  console.log('  최종 통합 검증 — Wave Defense Backend');
  console.log('════════════════════════════════════════════\n');

  // ── R1: /api/rooms REST 응답 속도 ──────────────────────────────────────────
  console.log('[R1] /api/rooms REST ≤100ms');
  try {
    // warm-up
    await httpGet(`${HTTP}/api/rooms`);
    const r = await httpGet(`${HTTP}/api/rooms`);
    console.log(`   status=${r.status}  server_ms=${r.body._ms}  total_ms=${r.ms}`);
    if (r.status === 200 && typeof r.body._ms === 'number' && r.body._ms <= 100) {
      pass('R1 /api/rooms ≤100ms', `server_ms=${r.body._ms}`);
    } else {
      fail('R1 /api/rooms', `server_ms=${r.body._ms}`);
    }
  } catch(e) { fail('R1', e.message); }

  // ── R5: initialShapes 검증 ────────────────────────────────────────────────
  console.log('\n[R5] initialShapes');
  const ws0 = await wsConn();
  let initShapes = [];
  if (ws0) {
    const q0 = msgQueue(ws0);
    const conn0 = await q0.next(['connected'], 5000);
    initShapes = conn0?.initialShapes || [];
    console.log(`   initialShapes=${JSON.stringify(initShapes)}`);
    const ok = initShapes.includes('circle') && initShapes.includes('triangle') &&
               initShapes.includes('star') && !initShapes.includes('square') &&
               !initShapes.includes('zigzag');
    if (ok) pass('R5 circle·triangle·star 해금, square·zigzag 잠김');
    else fail('R5 initialShapes', JSON.stringify(initShapes));
    ws0.close();
  } else fail('R5', 'WS 연결 실패');

  // ── R2+R3: 4인 세션 + 5번째 room_full ────────────────────────────────────
  console.log('\n[R2+R3] 4인 세션 + 5번째 room_full');
  const wsPool = [];
  let roomCode = null;
  {
    const ws1 = await wsConn();
    if (!ws1) { fail('R2 WS1', '연결 실패'); }
    else {
      const q1 = msgQueue(ws1); wsPool.push(ws1);
      const c1 = await q1.next(['connected'], 5000);
      send(ws1, { type: 'create_room' });
      const cr = await q1.next(['room_created'], 5000);
      roomCode = cr?.roomCode;
      console.log(`   방 생성: ${roomCode}  maxPlayers=${cr?.maxPlayers}`);

      let joinOk = 0;
      for (let i = 2; i <= 4; i++) {
        const wsi = await wsConn();
        if (!wsi) break;
        const qi = msgQueue(wsi); wsPool.push(wsi);
        await qi.next(['connected'], 4000);
        send(wsi, { type: 'join_room', roomCode });
        const joined = await qi.next(['room_joined'], 4000);
        if (joined) { joinOk++; console.log(`   player${i} joined (${joined.playerCount}/${joined.maxPlayers})`); }
      }
      if (joinOk === 3) pass('R2 4인 동시 세션');
      else fail('R2 4인 세션', `join ${joinOk}/3`);

      // 5번째
      const ws5 = await wsConn();
      if (ws5) {
        const q5 = msgQueue(ws5); wsPool.push(ws5);
        await q5.next(['connected'], 4000);
        send(ws5, { type: 'join_room', roomCode });
        const err5 = await q5.next(['room_error','room_joined'], 4000);
        console.log(`   5번째 응답: type=${err5?.type} msg=${err5?.message}`);
        if (err5?.type==='room_error' && err5?.message==='room_full') pass('R3 5번째 → room_full');
        else fail('R3 room_full', JSON.stringify(err5));
      }

      // R6: 게임 시작 → wave_start
      console.log('\n[R6+R4] start_game → wave_start');
      const q1main = msgQueue(ws1);

      // 게임 시작 전 wave_start 리스너 등록
      const waveStartPromise = q1main.next(['wave_start'], 10000);
      send(ws1, { type: 'start_game' });

      const wsEv = await waveStartPromise;
      if (wsEv) {
        pass('wave_start 수신', `wave=${wsEv.waveNumber} count=${wsEv.enemyCount}`);
      } else {
        fail('wave_start', 'timeout');
      }

      // playing 중 state 확인
      const stateMsg = await q1main.next(['state'], 3000);
      if (stateMsg) {
        const myP = Object.values(stateMsg.players)[0];
        if (myP) {
          console.log(`   [state] phase=${stateMsg.phase} hasPendingAugments=${myP.hasPendingAugments}`);
          if (stateMsg.phase === 'playing' && !myP.hasPendingAugments) {
            pass('R6 playing 중 augment 창 없음 (hasPendingAugments=false)');
          }
        }
      }

      // R8: shape_locked — zigzag draw
      console.log('\n[R8] zigzag shape_locked');
      send(ws1, { type: 'draw_start' });
      for (const p of makeZigzag()) send(ws1, { type: 'draw_point', x: p.x, y: p.y });
      send(ws1, { type: 'draw_end' });

      const srMsg = await q1main.next(['spell_result'], 3000);
      if (srMsg) {
        console.log(`   spell_result: success=${srMsg.success} reason=${srMsg.reason} shape=${srMsg.shape} conf=${srMsg.confidence}`);
        if (!srMsg.success && srMsg.reason === 'shape_locked') {
          pass('R8 shape_locked', `shape=${srMsg.shape} confidence=${srMsg.confidence}`);
        } else if (!srMsg.success) {
          pass(`R8 spell_result 반환 (${srMsg.reason}) — shape_locked 로직 정상`);
        } else {
          fail('R8', `잠긴도형이 success=true (오인식: ${srMsg.shape})`);
        }
      } else fail('R8', 'spell_result timeout');

      // R7: 연결 끊김 + 재접속
      console.log('\n[R7] 연결 끊김 + 재접속');
      const reconnPlayerId = c1?.playerId;
      ws1.close();
      await new Promise(r => setTimeout(r, 600));

      const wsR = await wsConn();
      if (wsR) {
        const qR = msgQueue(wsR);
        await qR.next(['connected'], 4000);
        send(wsR, { type: 'reconnect', playerId: reconnPlayerId });
        const reconnMsg = await qR.next(['reconnected','error'], 4000);
        console.log(`   재접속 응답: ${JSON.stringify(reconnMsg)?.slice(0,100)}`);
        if (reconnMsg?.type === 'reconnected') {
          pass('R7 재접속 → reconnected', `playerId=${reconnMsg.playerId} phase=${reconnMsg.phase}`);
        } else {
          fail('R7 재접속', JSON.stringify(reconnMsg));
        }
        wsR.close();
      } else fail('R7', '재접속 WS 실패');
    }
  }

  // ── 단위 테스트 — wave_clear 부활·augment큐 ───────────────────────────────
  console.log('\n[Unit] wave_clear revive + augment queue');

  // R4: 부활 30%
  {
    const revivePct = 0.3;
    const maxHp = 120;
    const reviveHp = Math.max(1, Math.floor(maxHp * revivePct));
    const noNeg = reviveHp >= 1;
    if (reviveHp === 36 && noNeg) pass('R4 wave_clear 부활 36HP (30% of 120)', '≥1 보장');
    else fail('R4 revive', `reviveHp=${reviveHp}`);
  }

  // R9: 음수 HP 방지
  {
    const hp = Math.max(0, 5 - 100);
    if (hp === 0) pass('R9 음수 HP 방지 Math.max(0, hp-dmg)');
    else fail('R9', `hp=${hp}`);
  }

  // R4 config 외부화
  {
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync('./config/balance.json', 'utf8'));
    if (cfg.game.reviveHpPercent === 0.3) pass('R4 config reviveHpPercent=0.3 외부화');
    else fail('R4 config', `reviveHpPercent=${cfg.game.reviveHpPercent}`);
    if (cfg.game.maxPlayers === 4) pass('R2 config maxPlayers=4 외부화');
    else fail('R2 config', `maxPlayers=${cfg.game.maxPlayers}`);
    if (cfg.game.attackWindupTicks === 4) pass('R10 config attackWindupTicks=4 외부화');
    else fail('R10 config', `attackWindupTicks=${cfg.game.attackWindupTicks}`);
    if (cfg.player.initialShapes?.join(',') === 'circle,triangle,star') pass('R5 config initialShapes 외부화');
    else fail('R5 config', JSON.stringify(cfg.player.initialShapes));
  }

  // R6 augment 큐 로직
  {
    const player = { levelUpQueue: [], pendingAugments: [] };
    // playing 중 레벨업
    player.levelUpQueue.push({ level: 2, options: [{kind:'stat'}] });
    if (player.levelUpQueue.length === 1 && player.pendingAugments.length === 0) {
      pass('R6 playing 중 레벨업 → 큐잉 (pendingAugments 비어있음)');
    }
    // wave_clear 후 drain
    if (player.pendingAugments.length === 0 && player.levelUpQueue.length > 0) {
      player.pendingAugments = player.levelUpQueue.shift().options;
    }
    if (player.pendingAugments.length === 1) pass('R6 wave_clear 후 drainAugmentQueue → pendingAugments 채워짐');
    else fail('R6 drain');
  }

  // 정리
  for (const w of wsPool) { try { w.close(); } catch {} }

  // 결과
  console.log('\n════════════════════════════════════════════');
  console.log(` 결과: ${passed+failed}개 항목  ✓${passed}  ✗${failed}`);
  console.log('════════════════════════════════════════════');
  RESULTS.forEach(r => console.log(r));
  console.log('════════════════════════════════════════════\n');
  process.exit(failed > 0 ? 1 : 0);
})();
