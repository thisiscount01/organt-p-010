'use strict';
(async () => {

// ── Constants ─────────────────────────────────────────────────────────────────
const GAME_W = 1200, GAME_H = 700;
const ELEMENT_COLORS = { fire:0xff4422, water:0x2288ff, lightning:0xffdd00, earth:0x44aa22 };
const ELEMENT_NAMES  = { fire:'불꽃', water:'물', lightning:'번개', earth:'땅' };
const ELEMENT_EMOJI  = { fire:'🔥', water:'💧', lightning:'⚡', earth:'🌿' };
const ENEMY_COLORS   = { basic:0x33cc55, fast:0xaa44ff, tank:0x778899, ranged:0x8800bb, boss:0xcc1100, shield:0x4488aa, healer:0x22ccaa };
const SPELL_NAMES    = { bolt:'BOLT', pierce:'PIERCE', chain:'CHAIN', nova:'NOVA', pulse:'PULSE' };
const SPELL_EMOJI    = { bolt:'⚡', pierce:'🔱', chain:'🌀', nova:'💥', pulse:'🌊' };

// ── State ─────────────────────────────────────────────────────────────────────
let ws = null;
let myPlayerId = null;
let myPlayerIndex = 0;
let myRoomCode = null;
let isHost = false;
let gameState = null;
let canvasLeft = 0, canvasTop = 0, canvasScale = 1;
let drawPoints = [];
let isDrawing  = false;
let advisorTimer = null;
const smoothPos = {};
let shakeIntensity = 0, shakeDuration = 0, shakeStart = 0;
const keys = {};
const dyingEnemies = new Map(); // id → { x, y, r, type, element, startTime }
let isPaused = false;
let myNickname = '';
let _lastHitSoundMs = 0;
// ── Game-state flags ──────────────────────────────────────────────────────────
let isBossWave = false;
let _spellOverlayTimer = null;
// ── Session stats (client-side kill/combo tracking for leaderboard) ───────────
let sessionKills = 0, sessionCurrentCombo = 0, sessionMaxCombo = 0, sessionLastKillTime = 0;

// ── Pixi Setup ─────────────────────────────────────────────────────────────────
const app = new PIXI.Application();
await app.init({
  width: GAME_W, height: GAME_H,
  background: 0x060612,
  antialias: true,
  resolution: 1,
});
app.canvas.style.position = 'fixed';
document.getElementById('game-wrap').appendChild(app.canvas);

// Layers
const worldContainer = new PIXI.Container();
app.stage.addChild(worldContainer);

const bgGfx   = new PIXI.Graphics();
const gameGfx = new PIXI.Graphics();
const fxGfx   = new PIXI.Graphics();
const particleContainer = new PIXI.Container();
const spellFxContainer  = new PIXI.Container(); // 마법진·확정 이펙트 (gameGfx 위, particles 아래)
const indicatorGfx = new PIXI.Graphics();   // off-screen enemy indicators (top layer)
worldContainer.addChild(bgGfx, gameGfx, spellFxContainer, particleContainer, fxGfx, indicatorGfx);

// ── Drawing Overlay Canvas ────────────────────────────────────────────────────
const drawCanvas  = document.createElement('canvas');
drawCanvas.id     = 'draw-canvas';
drawCanvas.width  = GAME_W;
drawCanvas.height = GAME_H;
document.getElementById('game-wrap').appendChild(drawCanvas);
const dctx = drawCanvas.getContext('2d');

// ── Resize ────────────────────────────────────────────────────────────────────
function resize() {
  const scale = Math.min(window.innerWidth / GAME_W, window.innerHeight / GAME_H);
  const w = GAME_W * scale, h = GAME_H * scale;
  canvasLeft = (window.innerWidth  - w) / 2;
  canvasTop  = (window.innerHeight - h) / 2;
  canvasScale = scale;
  for (const c of [app.canvas, drawCanvas]) {
    c.style.left   = canvasLeft + 'px';
    c.style.top    = canvasTop  + 'px';
    c.style.width  = w + 'px';
    c.style.height = h + 'px';
  }
}
resize();
window.addEventListener('resize', resize);

function toGame(cx, cy) {
  return {
    x: (cx - canvasLeft)  / canvasScale,
    y: (cy - canvasTop)   / canvasScale,
  };
}

// ── Float Text (DOM-based) ────────────────────────────────────────────────────
function showFloatText(gameX, gameY, text, cssColor) {
  const el = document.createElement('div');
  el.className = 'float-text';
  el.textContent = text;
  const sx = canvasLeft + gameX * canvasScale;
  const sy = canvasTop  + gameY * canvasScale;
  el.style.cssText = `left:${sx}px;top:${sy}px;color:${cssColor};text-shadow:0 0 10px ${cssColor};font-size:${Math.round(20*canvasScale)}px;`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 900);
}

// ── Web Audio API Sound System ────────────────────────────────────────────────
let _audioCtx = null;
function _getAC() {
  if (!_audioCtx) {
    try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
  }
  if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
  return _audioCtx;
}
function _tone(ctx, t, freq, endFreq, dur, vol, waveType) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.connect(g); g.connect(ctx.destination);
  o.type = waveType || 'sine';
  o.frequency.setValueAtTime(freq, t);
  if (endFreq && endFreq !== freq) o.frequency.exponentialRampToValueAtTime(endFreq, t + dur * 0.88);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.start(t); o.stop(t + dur + 0.02);
}
function playSound(type) {
  const ctx = _getAC(); if (!ctx) return;
  const t = ctx.currentTime;
  switch (type) {
    case 'hit': {
      const nowMs = t * 1000;
      if (nowMs - _lastHitSoundMs < 55) return; // throttle ~18/s
      _lastHitSoundMs = nowMs;
      _tone(ctx, t, 340, 70, 0.09, 0.14, 'square');
      break;
    }
    case 'wave_start':
      _tone(ctx, t,      180, 520, 0.40, 0.12, 'sawtooth');
      _tone(ctx, t+0.06, 240, 680, 0.30, 0.09, 'sine');
      break;
    case 'level_up':
      [440, 550, 660, 880].forEach((f, i) => _tone(ctx, t + i*0.10, f, f*1.08, 0.18, 0.18, 'sine'));
      break;
    case 'game_over':
      [280, 210, 150, 90].forEach((f, i) => _tone(ctx, t + i*0.22, f, f*0.65, 0.24, 0.14, 'sawtooth'));
      break;
  }
}

// ── Particle System (Pool-based — GC spike 방지) ─────────────────────────────
// 파티클 풀: 사전 할당 → 재사용으로 GC 스파이크 차단
// 풀 용량 = 2P 동시 이펙트 최대치(시너지 버스트 2회 + 레벨업 + 다수 히트) 기준 산정
const PARTICLE_POOL_SIZE = 400;
const _partPool = [];  // 사용 가능한 Graphics 객체 저장
const _parts    = [];  // 현재 활성 파티클

// 앱 초기화 후 PIXI.Graphics 사전 할당
for (let i = 0; i < PARTICLE_POOL_SIZE; i++) _partPool.push(new PIXI.Graphics());

/**
 * emitParticles — 파티클 방출 (풀 기반).
 * opts.shape      : 'circle'(기본)|'spark'|'square'|'ember' — 속성별 궤적 분기
 * opts.gravity    : 중력 계수 (기본 0.14)
 * opts.decay      : [min, max] 감쇠 범위
 * opts.sizeRange  : [min, max] 크기 범위
 * opts.angleSpread: goUp=true일 때 수직 방향 흔들림 범위 (기본 1.4)
 */
function emitParticles(x, y, color, count = 10, speed = 4, goUp = false, opts = {}) {
  const shape    = opts.shape       ?? 'circle';
  const gravity  = opts.gravity     ?? 0.14;
  const decayMin = opts.decay       ? opts.decay[0] : 0.024;
  const decayMax = opts.decay       ? opts.decay[1] : 0.048;
  const szMin    = opts.sizeRange   ? opts.sizeRange[0] : 3;
  const szMax    = opts.sizeRange   ? opts.sizeRange[1] : 6;
  const spread   = opts.angleSpread ?? 1.4;
  // 풀 부족 시 발행 수 제한(프레임 드롭 대신 파티클 수 축소)
  const actual = Math.min(count, _partPool.length);
  for (let i = 0; i < actual; i++) {
    const angle = goUp
      ? -Math.PI / 2 + (Math.random() - 0.5) * spread
      : Math.random() * Math.PI * 2;
    const spd = speed * (0.5 + Math.random());
    const g   = _partPool.pop();
    particleContainer.addChild(g);
    _parts.push({
      g, x, y,
      vx: Math.cos(angle) * spd,
      vy: Math.sin(angle) * spd,
      life: 1.0,
      decay: decayMin + Math.random() * (decayMax - decayMin),
      color, size: szMin + Math.random() * (szMax - szMin),
      shape, gravity,
      rot: Math.random() * Math.PI * 2,  // square/ember 회전용
    });
  }
}

function updateParticles() {
  for (let i = _parts.length - 1; i >= 0; i--) {
    const p = _parts[i];
    p.x  += p.vx; p.y += p.vy;
    p.vy += p.gravity;
    p.vx *= 0.97;  // 수평 저항
    p.life -= p.decay;
    if (p.life <= 0) {
      p.g.clear();
      particleContainer.removeChild(p.g);
      _partPool.push(p.g);  // 풀 반환
      _parts.splice(i, 1);
    } else {
      p.g.clear();
      const a = p.life;
      const s = p.size * p.life;
      switch (p.shape) {
        case 'spark':
          // 번개 spark: 후방 잔상 점 2개로 전기 궤적 표현
          p.g.circle(p.x, p.y, s * 0.65).fill({ color: p.color, alpha: a });
          p.g.circle(p.x - p.vx * 1.4, p.y - p.vy * 1.4, s * 0.38).fill({ color: p.color, alpha: a * 0.5 });
          break;
        case 'square':
          // 땅 파편: 회전하는 사각형
          p.rot += 0.09;
          { const hs = s * 0.58;
            p.g.rect(p.x - hs, p.y - hs, hs * 2, hs * 2).fill({ color: p.color, alpha: a * 0.88 }); }
          break;
        case 'ember':
          // 불꽃 ember: 위쪽 뾰족한 물방울 형태(타원으로 근사)
          p.g.circle(p.x, p.y, s * 0.55).fill({ color: p.color, alpha: a });
          p.g.circle(p.x, p.y - s * 0.4, s * 0.28).fill({ color: p.color, alpha: a * 0.6 });
          break;
        default:
          // circle (기본)
          p.g.circle(p.x, p.y, s).fill({ color: p.color, alpha: a });
      }
    }
  }
}

// ── 속성별 파티클 파라미터 (3채널: 색·궤적·중력) ────────────────────────────────
// 텍스트 없이 속성을 즉각 구별할 수 있도록 각 채널을 독립적으로 분기
const ELEMENT_VFX = {
  fire:      { shape: 'ember',  gravity: 0.22, speed: 6.5, sizeRange: [3, 8], decay: [0.020, 0.040], secondColor: 0xffdd00, secondRatio: 0.45, secondOpts: { shape: 'ember', gravity: 0.28, sizeRange: [2, 4], decay: [0.030, 0.055] } },
  water:     { shape: 'circle', gravity: 0.03, speed: 3.2, sizeRange: [4, 9], decay: [0.016, 0.032], secondColor: 0x88eeff, secondRatio: 0.55, secondOpts: { shape: 'circle', gravity: 0.01, sizeRange: [5, 11], decay: [0.013, 0.025] } },
  lightning: { shape: 'spark',  gravity: 0.01, speed: 9.5, sizeRange: [2, 5], decay: [0.032, 0.060], secondColor: 0xffffff, secondRatio: 0.35, secondOpts: { shape: 'spark', gravity: 0.00, sizeRange: [1, 3], decay: [0.040, 0.070] } },
  earth:     { shape: 'square', gravity: 0.28, speed: 4.0, sizeRange: [3, 7], decay: [0.020, 0.040], secondColor: 0x88cc44, secondRatio: 0.38, secondOpts: { shape: 'circle', gravity: 0.35, sizeRange: [2, 5], decay: [0.025, 0.045] } },
};

/**
 * emitElementParticles — 속성별 3채널 파티클 방출.
 * 주 색·형태 + 보조 색·형태를 동시 방출해 속성 즉각 구별.
 */
function emitElementParticles(x, y, element, count, overrideSpeed) {
  const c   = elemColor(element);
  const cfg = ELEMENT_VFX[element];
  if (!cfg) { emitParticles(x, y, c, count, overrideSpeed ?? 5); return; }
  const spd = overrideSpeed ?? cfg.speed;
  emitParticles(x, y, c, count, spd, false, cfg);
  const secCount = Math.max(1, Math.round(count * cfg.secondRatio));
  emitParticles(x, y, cfg.secondColor, secCount, spd * 0.85, element === 'fire' || element === 'earth', cfg.secondOpts);
}

// ── Camera Shake ──────────────────────────────────────────────────────────────
function cameraShake(intensity = 6, duration = 400) {
  shakeIntensity = intensity;
  shakeDuration  = duration;
  shakeStart     = performance.now();
}

// ── Draw Canvas Helpers ───────────────────────────────────────────────────────
function clearDraw() { dctx.clearRect(0, 0, GAME_W, GAME_H); }

function renderTrail(pts, r, g, b, alpha) {
  clearDraw();
  if (pts.length < 2) return;
  dctx.beginPath();
  dctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) dctx.lineTo(pts[i].x, pts[i].y);
  dctx.strokeStyle  = `rgba(${r},${g},${b},${alpha})`;
  dctx.lineWidth    = 4;
  dctx.lineCap      = 'round';
  dctx.lineJoin     = 'round';
  dctx.shadowBlur   = 18;
  dctx.shadowColor  = `rgba(${r},${g},${b},0.7)`;
  dctx.stroke();
  dctx.shadowBlur   = 0;
  for (const p of pts) {
    dctx.beginPath();
    dctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    dctx.fillStyle = `rgba(${r},${g},${b},${alpha * 0.5})`;
    dctx.fill();
  }
}

function flashTrail(pts, success, tierColor) {
  let [r, g, b] = success ? [80, 255, 120] : [255, 60, 60];
  // tier-specific color override on success
  if (success && tierColor === 'gold')  { r=255; g=204; b=0;   }
  if (success && tierColor === 'white') { r=220; g=230; b=255; }
  if (success && tierColor === 'gray')  { r=150; g=160; b=170; }
  let alpha = 1.0;
  const step = () => {
    renderTrail(pts, r, g, b, alpha);
    alpha -= 0.07;
    if (alpha > 0) requestAnimationFrame(step);
    else clearDraw();
  };
  step();
}

// ── Drawing Input ─────────────────────────────────────────────────────────────
function clientXY(e) {
  if (e.touches && e.touches[0]) return [e.touches[0].clientX, e.touches[0].clientY];
  return [e.clientX, e.clientY];
}

function startDraw(e) {
  if (!gameState || gameState.phase !== 'playing') return;
  if (isPaused) return;
  if (e.button === 2) return;
  isDrawing = true; drawPoints = [];
  const [cx, cy] = clientXY(e);
  drawPoints.push(toGame(cx, cy));
  sendWS({ type: 'draw_start' });
  e.preventDefault();
}

function moveDraw(e) {
  if (!isDrawing) return;
  const [cx, cy] = clientXY(e);
  const p = toGame(cx, cy);
  drawPoints.push(p);
  renderTrail(drawPoints, 200, 220, 255, 0.9);
  sendWS({ type: 'draw_point', ...p });
  e.preventDefault();
}

function endDraw(e) {
  if (!isDrawing) return;
  isDrawing = false;
  sendWS({ type: 'draw_end' });
  // Goal 1: draw_end 즉시 "인식 중..." 오버레이 표시
  if (gameState?.phase === 'playing') showRecognizing();
  e.preventDefault();
}

drawCanvas.addEventListener('mousedown',  startDraw);
drawCanvas.addEventListener('mousemove',  moveDraw);
drawCanvas.addEventListener('mouseup',    endDraw);
drawCanvas.addEventListener('mouseleave', endDraw);
drawCanvas.addEventListener('touchstart', startDraw, { passive: false });
drawCanvas.addEventListener('touchmove',  moveDraw,  { passive: false });
drawCanvas.addEventListener('touchend',   endDraw,   { passive: false });
drawCanvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  if (!gameState || gameState.phase !== 'playing') return;
  const pos = toGame(e.clientX, e.clientY);
  sendWS({ type: 'move', x: pos.x, y: pos.y });
});

// ── Keyboard ──────────────────────────────────────────────────────────────────
window.addEventListener('keydown', e => { keys[e.code] = true; });
window.addEventListener('keyup',   e => { keys[e.code] = false; });

let moveThrottle = 0;
function processMoveInput() {
  if (!gameState || gameState.phase !== 'playing' || !myPlayerId) return;
  const me = gameState.players?.[myPlayerId];
  if (!me || !me.alive) return;

  const spd = 48;
  let tx = me.x, ty = me.y;
  let moved = false;
  if (keys['KeyW'] || keys['ArrowUp'])    { ty -= spd; moved = true; }
  if (keys['KeyS'] || keys['ArrowDown'])  { ty += spd; moved = true; }
  if (keys['KeyA'] || keys['ArrowLeft'])  { tx -= spd; moved = true; }
  if (keys['KeyD'] || keys['ArrowRight']) { tx += spd; moved = true; }

  if (moved) {
    tx = Math.max(20, Math.min(GAME_W - 20, tx));
    ty = Math.max(20, Math.min(GAME_H - 20, ty));
    // NO local prediction: server is authoritative. Just send the intent.
    moveThrottle++;
    if (moveThrottle % 2 === 0) sendWS({ type: 'move', x: tx, y: ty });
  }
}

// Right-click on pixi canvas → move
app.canvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  if (!gameState || gameState.phase !== 'playing') return;
  const pos = toGame(e.clientX, e.clientY);
  sendWS({ type: 'move', x: pos.x, y: pos.y });
});

// ── Background ────────────────────────────────────────────────────────────────
function drawBackground() {
  bgGfx.clear();
  // Goal 3: boss wave 시 배경 색온도 전환(cool blue → warm red)
  const bgColor    = isBossWave ? 0x140606 : 0x080818;
  const gridColor  = isBossWave ? 0x200808 : 0x0f1830;
  const borderColor= isBossWave ? 0x441522 : 0x223355;
  const cornerColor= isBossWave ? 0x060000 : 0x000010;
  bgGfx.rect(0, 0, GAME_W, GAME_H).fill(bgColor);
  for (let x = 0; x <= GAME_W; x += 60)
    bgGfx.moveTo(x, 0).lineTo(x, GAME_H).stroke({ color: gridColor, width: 1 });
  for (let y = 0; y <= GAME_H; y += 60)
    bgGfx.moveTo(0, y).lineTo(GAME_W, y).stroke({ color: gridColor, width: 1 });
  bgGfx.rect(0, 0, GAME_W, GAME_H).stroke({ color: borderColor, width: 2 });
  for (const [cx, cy] of [[0,0],[GAME_W,0],[0,GAME_H],[GAME_W,GAME_H]])
    bgGfx.circle(cx, cy, 220).fill({ color: cornerColor, alpha: 0.5 });
}
drawBackground();

// ── Boss Wave Visual Toggle (Goal 3) ─────────────────────────────────────────
function setBossWaveVisuals(active) {
  if (isBossWave === active) return;
  isBossWave = active;
  drawBackground();
  const vignette = document.getElementById('boss-wave-vignette');
  if (vignette) vignette.style.display = active ? 'block' : 'none';
}

// ── Spell Recognition Overlay (Goal 1) ───────────────────────────────────────
function showRecognizing() {
  const recEl  = document.getElementById('spell-overlay-recognizing');
  const nameEl = document.getElementById('spell-overlay-name');
  if (!recEl || !nameEl) return;
  if (_spellOverlayTimer) { clearTimeout(_spellOverlayTimer); _spellOverlayTimer = null; }
  nameEl.style.display = 'none';
  nameEl.style.opacity = '1';
  recEl.style.display  = 'block';
}

function showSpellName(spellType, element) {
  const recEl  = document.getElementById('spell-overlay-recognizing');
  const nameEl = document.getElementById('spell-overlay-name');
  if (!recEl || !nameEl) return;
  if (_spellOverlayTimer) { clearTimeout(_spellOverlayTimer); _spellOverlayTimer = null; }
  recEl.style.display  = 'none';
  const color = elemHex(element) ?? '#ffffff';
  nameEl.textContent = `${SPELL_EMOJI[spellType] ?? '✦'} ${(SPELL_NAMES[spellType] ?? spellType).toUpperCase()}`;
  nameEl.style.color = color;
  nameEl.style.textShadow = `0 0 28px ${color}, 0 0 56px ${color}88`;
  nameEl.style.opacity = '1';
  nameEl.style.transition = '';
  nameEl.style.display = 'block';
  // restart animation
  nameEl.style.animation = 'none';
  void nameEl.offsetHeight;
  nameEl.style.animation = 'spellNamePop 0.18s ease-out';
  // auto-hide after 1.5s with fade
  _spellOverlayTimer = setTimeout(() => {
    nameEl.style.transition = 'opacity .35s';
    nameEl.style.opacity = '0';
    setTimeout(() => {
      nameEl.style.display = 'none';
      nameEl.style.opacity = '1';
      nameEl.style.transition = '';
      _spellOverlayTimer = null;
    }, 360);
  }, 1140);
}

function hideSpellOverlay() {
  const recEl  = document.getElementById('spell-overlay-recognizing');
  const nameEl = document.getElementById('spell-overlay-name');
  if (recEl)  recEl.style.display  = 'none';
  if (nameEl) { nameEl.style.display = 'none'; nameEl.style.opacity = '1'; nameEl.style.transition = ''; }
  if (_spellOverlayTimer) { clearTimeout(_spellOverlayTimer); _spellOverlayTimer = null; }
}

// ── Smooth Positions ──────────────────────────────────────────────────────────
function getSP(id, tx, ty, lerp = 0.25) {
  if (!smoothPos[id]) { smoothPos[id] = { x: tx, y: ty }; }
  else {
    smoothPos[id].x += (tx - smoothPos[id].x) * lerp;
    smoothPos[id].y += (ty - smoothPos[id].y) * lerp;
  }
  return smoothPos[id];
}

function elemColor(el) { return ELEMENT_COLORS[el] ?? 0xaaaaaa; }
function elemHex(el) {
  const c = ELEMENT_COLORS[el] ?? 0xaaaaaa;
  return '#' + c.toString(16).padStart(6,'0');
}

// ── Element Icon ──────────────────────────────────────────────────────────────
function drawElemIcon(g, el, x, y, sz) {
  const c = elemColor(el);
  switch (el) {
    case 'fire':
      g.poly([x, y-sz, x-sz*.7, y+sz*.5, x, y+sz*.2, x+sz*.7, y+sz*.5]).fill(c);
      g.circle(x, y, sz*.35).fill({ color: 0xffdd00, alpha: 0.8 });
      break;
    case 'water':
      g.circle(x, y+sz*.1, sz*.8).fill(c);
      g.circle(x, y-sz*.2, sz*.5).fill({ color: 0x88ddff, alpha: 0.5 });
      break;
    case 'lightning':
      g.poly([x+sz*.3, y-sz, x-sz*.15, y-.1, x+sz*.25, y-.1, x-sz*.3, y+sz]).fill(c);
      break;
    case 'earth':
      g.poly([x, y-sz, x+sz, y, x, y+sz, x-sz, y]).fill(c);
      g.poly([x, y-sz*.55, x+sz*.55, y, x, y+sz*.55, x-sz*.55, y]).fill({ color: 0x88cc66, alpha: 0.5 });
      break;
    default:
      g.circle(x, y, sz*.7).fill(0x888888);
  }
}

// ── Render Game Frame ─────────────────────────────────────────────────────────
function renderGame(state) {
  gameGfx.clear();

  // ── Spells ──
  for (const s of (state.spells || [])) {
    const pos = getSP('s_' + s.id, s.x, s.y, 0.5);
    const c   = elemColor(s.element);
    // Shape-specific projectile visuals
    const st = s.spellType || 'bolt';
    if (st === 'pierce') {
      // Piercing: elongated diamond
      gameGfx.poly([pos.x, pos.y-s.radius*2.2, pos.x+s.radius*.7, pos.y, pos.x, pos.y+s.radius*2.2, pos.x-s.radius*.7, pos.y]).fill({ color: c, alpha: 0.9 });
      gameGfx.circle(pos.x, pos.y, s.radius*.5).fill({ color: 0xffffff, alpha: 0.6 });
    } else if (st === 'nova') {
      // Nova: spiky star
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        gameGfx.poly([
          pos.x + Math.cos(a)*(s.radius*1.8), pos.y + Math.sin(a)*(s.radius*1.8),
          pos.x + Math.cos(a+.4)*(s.radius*.6), pos.y + Math.sin(a+.4)*(s.radius*.6),
          pos.x + Math.cos(a-.4)*(s.radius*.6), pos.y + Math.sin(a-.4)*(s.radius*.6),
        ]).fill({ color: c, alpha: 0.75 });
      }
      gameGfx.circle(pos.x, pos.y, s.radius*.8).fill({ color: c, alpha: 0.9 });
    } else if (st === 'chain') {
      // Chain: hexagonal
      const pts = [];
      for (let i = 0; i < 6; i++) { const a = (i/6)*Math.PI*2; pts.push(pos.x+Math.cos(a)*s.radius*1.3, pos.y+Math.sin(a)*s.radius*1.3); }
      gameGfx.poly(pts).fill({ color: c, alpha: 0.85 });
      gameGfx.circle(pos.x, pos.y, s.radius*.4).fill({ color: 0xffffff, alpha: 0.7 });
    } else if (st === 'pulse') {
      // Pulse: expanding ring (handled on cast, show as ring)
      gameGfx.circle(pos.x, pos.y, s.radius+6).stroke({ color: c, width: 3, alpha: 0.6 });
      gameGfx.circle(pos.x, pos.y, s.radius).fill({ color: c, alpha: 0.35 });
    } else {
      // bolt: default orb
      for (let i = 3; i >= 1; i--)
        gameGfx.circle(pos.x, pos.y, s.radius + i * 5).fill({ color: c, alpha: 0.1 });
      gameGfx.circle(pos.x, pos.y, s.radius).fill(c);
      gameGfx.circle(pos.x, pos.y, s.radius * .45).fill({ color: 0xffffff, alpha: 0.7 });
    }
  }

  // ── Enemy Projectiles ──
  for (const pr of (state.projList || [])) {
    const pos = getSP('pr_' + pr.id, pr.x, pr.y, 0.55);
    const c   = pr.element ? elemColor(pr.element) : 0xff6600;
    gameGfx.circle(pos.x, pos.y, pr.radius + 3).fill({ color: c, alpha: 0.3 });
    gameGfx.circle(pos.x, pos.y, pr.radius).fill(c);
  }

  // ── Enemies ──
  for (const e of (state.enemies || [])) {
    const pos    = getSP('e_' + e.id, e.x, e.y);
    const c      = ENEMY_COLORS[e.type] ?? 0xaaaaaa;
    const r      = e.radius;
    const hpPct  = e.hp / e.maxHp;

    if (e.type === 'boss') {
      for (let i = 5; i >= 1; i--)
        gameGfx.circle(pos.x, pos.y, r + i * 10).fill({ color: 0xcc0000, alpha: 0.06 });
      gameGfx.circle(pos.x, pos.y, r).fill(c);
      gameGfx.circle(pos.x, pos.y, r * .7).fill({ color: 0xff3300, alpha: 0.55 });
      for (const [ox, oy] of [[-r*.35, -r*.15],[r*.35, -r*.15]]) {
        gameGfx.circle(pos.x+ox, pos.y+oy, r*.17).fill(0xffee00);
        gameGfx.circle(pos.x+ox, pos.y+oy, r*.09).fill(0xff0000);
      }
      // Goal 3: 보스 전용 아웃라인 (박동 애니메이션)
      const bossAura = 0.5 + 0.35 * Math.sin(performance.now() / 260);
      gameGfx.circle(pos.x, pos.y, r + 12).stroke({ color: 0xff2200, width: 3, alpha: bossAura });
      gameGfx.circle(pos.x, pos.y, r + 24).stroke({ color: 0xff6600, width: 1.5, alpha: bossAura * 0.45 });
    } else if (e.type === 'tank') {
      gameGfx.circle(pos.x, pos.y, r).fill(c);
      gameGfx.circle(pos.x, pos.y, r * .72).fill({ color: 0x99aabb, alpha: 0.5 });
      gameGfx.rect(pos.x - r*.4, pos.y - r*.15, r*.8, r*.3).fill({ color: 0x334455, alpha: 0.9 });
    } else if (e.type === 'ranged') {
      gameGfx.circle(pos.x, pos.y, r).fill(c);
      gameGfx.circle(pos.x, pos.y, r * .5).fill({ color: 0xdd00ff, alpha: 0.55 });
      gameGfx.circle(pos.x, pos.y - r - 9, 6).fill({ color: 0xdd00ff, alpha: 0.85 });
    } else if (e.type === 'fast') {
      gameGfx.circle(pos.x, pos.y, r).fill(c);
      gameGfx.circle(pos.x, pos.y, r * .55).fill({ color: 0xcc88ff, alpha: 0.5 });
      // Speed trail dots
      gameGfx.circle(pos.x - 8, pos.y, r*.35).fill({ color: c, alpha: 0.3 });
      gameGfx.circle(pos.x - 16, pos.y, r*.2).fill({ color: c, alpha: 0.15 });
    } else if (e.type === 'shield') {
      gameGfx.circle(pos.x, pos.y, r).fill(c);
      gameGfx.circle(pos.x, pos.y, r*.85).stroke({ color: 0x88ccff, width: 3, alpha: 0.7 });
      gameGfx.rect(pos.x - r*.3, pos.y - r*.55, r*.6, r*.8).fill({ color: 0x334466, alpha: 0.8 });
    } else if (e.type === 'healer') {
      gameGfx.circle(pos.x, pos.y, r).fill(c);
      gameGfx.circle(pos.x, pos.y, r * .6).fill({ color: 0x88ffdd, alpha: 0.45 });
      // Cross
      gameGfx.rect(pos.x-r*.15, pos.y-r*.5, r*.3, r).fill({ color: 0xffffff, alpha: 0.6 });
      gameGfx.rect(pos.x-r*.5, pos.y-r*.15, r, r*.3).fill({ color: 0xffffff, alpha: 0.6 });
    } else {
      // basic
      gameGfx.circle(pos.x, pos.y, r).fill(c);
      gameGfx.circle(pos.x - r*.3, pos.y - r*.2, r*.2).fill(0xffffff);
      gameGfx.circle(pos.x + r*.3, pos.y - r*.2, r*.2).fill(0xffffff);
      gameGfx.circle(pos.x - r*.3, pos.y - r*.2, r*.1).fill(0x000000);
      gameGfx.circle(pos.x + r*.3, pos.y - r*.2, r*.1).fill(0x000000);
    }

    // Element dot
    if (e.element)
      gameGfx.circle(pos.x + r*.72, pos.y - r*.72, 5).fill(elemColor(e.element));

    // HP bar
    const bw = r * 2 + 8;
    const bx = pos.x - r - 4;
    const by = pos.y - r - 15;
    gameGfx.rect(bx, by, bw, 6).fill({ color: 0x1a1a2e, alpha: 0.85 });
    const bc = hpPct > .5 ? 0x22cc44 : hpPct > .25 ? 0xffaa00 : 0xff3300;
    if (hpPct > 0) gameGfx.rect(bx, by, bw * hpPct, 6).fill(bc);
    gameGfx.rect(bx, by, bw, 6).stroke({ color: 0x334455, width: 1 });
  }

  // ── Dying Enemies (fade-out 1200ms) ──
  {
    const nowMs = performance.now();
    for (const [eid, de] of dyingEnemies) {
      const elapsed = nowMs - de.startTime;
      if (elapsed >= 1200) { dyingEnemies.delete(eid); continue; }
      const alpha = (1 - elapsed / 1200) * 0.9;
      const dc = ENEMY_COLORS[de.type] ?? 0xaaaaaa;
      gameGfx.circle(de.x, de.y, de.r).fill({ color: dc, alpha });
      if (de.element) gameGfx.circle(de.x + de.r * .72, de.y - de.r * .72, 5).fill({ color: elemColor(de.element), alpha });
      // Empty HP bar fading out with the sprite
      const dbw = de.r * 2 + 8, dbx = de.x - de.r - 4, dby = de.y - de.r - 15;
      gameGfx.rect(dbx, dby, dbw, 6).fill({ color: 0x1a1a2e, alpha: alpha * 0.85 });
      gameGfx.rect(dbx, dby, dbw, 6).stroke({ color: 0x334455, width: 1, alpha });
    }
  }

  // ── Players ──
  for (const p of Object.values(state.players || {})) {
    if (!p.alive) continue;
    // Use a faster lerp for my own player to reduce perceived lag
    const lerpVal = p.id === myPlayerId ? 0.35 : 0.25;
    const pos = getSP('p_' + p.id, p.x, p.y, lerpVal);
    const c   = elemColor(p.element);
    const r   = 18;
    const isMe = p.id === myPlayerId;

    // Glow rings
    const rings = isMe ? 3 : 2;
    for (let i = rings; i >= 1; i--)
      gameGfx.circle(pos.x, pos.y, r + i * 7).fill({ color: c, alpha: 0.08 });

    // Body
    gameGfx.circle(pos.x, pos.y, r).fill(c);
    gameGfx.circle(pos.x, pos.y, r * .55).fill({ color: 0xffffff, alpha: 0.18 });

    // Element icon
    drawElemIcon(gameGfx, p.element, pos.x, pos.y, 8);

    // P-index badge
    const bx = pos.x + r * .58, by = pos.y - r * .58;
    gameGfx.circle(bx, by, 8).fill(0x0a0a1a);
    gameGfx.circle(bx, by, 6).fill(p.index === 0 ? 0xff5544 : 0x44aaff);

    // Invincibility indicator
    if (p.invincible > 0)
      gameGfx.circle(pos.x, pos.y, r + 5).stroke({ color: 0xffffff, width: 2, alpha: 0.55 });

    // Underline strip
    gameGfx.rect(pos.x - 14, pos.y + r + 4, 28, 4)
           .fill({ color: p.index === 0 ? 0xff5544 : 0x44aaff, alpha: 0.75 });
  }
}

// ── VFX ───────────────────────────────────────────────────────────────────────
function vfxWaveStart(waveNum, hasBoss) {
  const c = hasBoss ? 0xff1100 : 0x4466ff;
  let t = 0;
  const tick = () => {
    fxGfx.clear();
    const alpha = Math.max(0, 0.65 - t / 30);
    fxGfx.rect(0, 0, GAME_W, GAME_H).stroke({ color: c, width: 3 + t * .5, alpha });
    t++;
    if (t >= 36) { fxGfx.clear(); app.ticker.remove(tick); }
  };
  app.ticker.add(tick);
  for (let i = 0; i < 32; i++) setTimeout(() => {
    const side = i % 4;
    const [ex, ey] = side === 0 ? [Math.random() * GAME_W, 5]
                   : side === 1 ? [GAME_W - 5, Math.random() * GAME_H]
                   : side === 2 ? [Math.random() * GAME_W, GAME_H - 5]
                   :              [5, Math.random() * GAME_H];
    emitParticles(ex, ey, c, 6, 3);
  }, i * 45);
}

function vfxWaveClear() {
  let t = 0;
  const ring = new PIXI.Graphics();
  worldContainer.addChild(ring);
  const tick = () => {
    t++;
    ring.clear();
    const alpha = Math.max(0, 1 - t / 42);
    ring.circle(GAME_W/2, GAME_H/2, t*28).stroke({ color: 0xffdd00, width: 5, alpha });
    ring.circle(GAME_W/2, GAME_H/2, t*20).stroke({ color: 0xffffff, width: 2, alpha: alpha*.4 });
    if (t >= 44) { worldContainer.removeChild(ring); ring.destroy(); app.ticker.remove(tick); }
  };
  app.ticker.add(tick);
  for (let i = 0; i < 55; i++) setTimeout(() =>
    emitParticles(
      GAME_W/2 + (Math.random()-.5)*500,
      GAME_H/2 + (Math.random()-.5)*350,
      0xffdd00, 10, 5
    ), i * 28);
}

function vfxLevelUp(px, py, element) {
  // Goal 2: 레벨업 방사 버스트 + 속성 aura 이펙트
  const c = elemColor(element);
  let t = 0;
  const beam = new PIXI.Graphics();
  const aura = new PIXI.Graphics();
  worldContainer.addChild(beam);
  worldContainer.addChild(aura);

  const tick = () => {
    t++;
    beam.clear();
    aura.clear();
    const alpha = Math.max(0, 1 - t / 36);
    // 기존 빔 연출
    beam.rect(px - 4, 0, 8, py - t * 9).fill({ color: c, alpha });
    beam.rect(px - 14, 0, 28, py - t * 9).fill({ color: c, alpha: alpha * .18 });
    // 속성 Aura ring: 밖으로 확산하며 페이드
    if (t <= 32) {
      const auraA = Math.max(0, 1 - t / 32);
      aura.circle(px, py, 18 + t * 10).stroke({ color: c, width: 4, alpha: auraA });
      aura.circle(px, py, 18 + t * 10).fill({ color: c, alpha: auraA * 0.07 });
      aura.circle(px, py, 18 + t * 7).stroke({ color: 0xffffff, width: 1.5, alpha: auraA * 0.4 });
      // 초반 코어 폭발 플래시
      if (t <= 7) {
        const coreA = (7 - t) / 7;
        aura.circle(px, py, (8 - t) * 8).fill({ color: 0xffffff, alpha: coreA * 0.55 });
      }
    }
    if (t >= 38) {
      worldContainer.removeChild(beam); beam.destroy();
      worldContainer.removeChild(aura); aura.destroy();
      app.ticker.remove(tick);
    }
  };
  app.ticker.add(tick);

  // 방사 버스트: 360° 전방향 — 속성별 3채널 파티클
  emitElementParticles(px, py, element, 60, 11);
  emitParticles(px, py, 0xffffff, 22, 15, false, { shape: 'circle', gravity: 0.04, decay: [0.020, 0.040] });

  // 속성별 상승 파티클 (성장감 가시화)
  const lvCfg = ELEMENT_VFX[element];
  for (let i = 0; i < 22; i++)
    setTimeout(() => {
      const ox = (Math.random() - .5) * 32;
      if (lvCfg) emitParticles(px + ox, py, elemColor(element), 4, lvCfg.speed * 0.55, true, { shape: lvCfg.shape, gravity: lvCfg.gravity * 0.35, sizeRange: [2, 5] });
      else emitParticles(px + ox, py, c, 4, 3, true);
    }, i * 50);

  // 레벨업 알림 텍스트
  showFloatText(px, py - 46, '✦ LEVEL UP!', elemHex(element) ?? '#ffffff');
}

function vfxBossSpawn(bx, by, element) {
  const c    = element ? elemColor(element) : 0xff0000;
  const cGlow = element === 'fire' ? 0xff3300 : element === 'water' ? 0x0055ff
              : element === 'lightning' ? 0xffcc00 : element === 'earth' ? 0x226600
              : 0xff0000;
  cameraShake(18, 800);

  const overlay = new PIXI.Graphics();
  overlay.rect(0, 0, GAME_W, GAME_H).fill({ color: 0x000000, alpha: 0.72 });
  worldContainer.addChild(overlay);

  const bolt    = new PIXI.Graphics();
  const bossRings = new PIXI.Graphics();
  worldContainer.addChild(bolt);
  worldContainer.addChild(bossRings);

  let t = 0;
  const tick = () => {
    t++;
    // 암전 페이드아웃
    const darkA = Math.max(0, 0.72 - t / 52);
    overlay.clear();
    overlay.rect(0, 0, GAME_W, GAME_H).fill({ color: 0x000000, alpha: darkA });

    // 번개 낙하 볼트 (초반 20프레임)
    if (t < 22) {
      bolt.clear();
      const boltA = Math.max(0, 1 - t / 22);
      const pts = [bx, 0];
      for (let i = 1; i < 10; i++) pts.push(bx + (Math.random() - 0.5) * 110, (i / 10) * by);
      pts.push(bx, by);
      bolt.poly(pts).stroke({ color: c, width: 4, alpha: boltA * 0.95 });
      bolt.poly(pts).stroke({ color: 0xffffff, width: 1.5, alpha: boltA * 0.55 });
    } else {
      bolt.clear();
    }

    // 보스 등장 충격파 링 (t=18~55)
    if (t >= 18 && t <= 56) {
      const rp = t - 18;
      bossRings.clear();
      for (let ri = 0; ri < 3; ri++) {
        const rr  = Math.max(0, (rp - ri * 7) * 18);
        const ra  = Math.max(0, 0.8 - (rp - ri * 7) / 38);
        if (rr > 0) {
          bossRings.circle(bx, by, rr).stroke({ color: c,    width: 3.5, alpha: ra });
          bossRings.circle(bx, by, rr * 0.7).stroke({ color: 0xffffff, width: 1.2, alpha: ra * 0.35 });
        }
      }
    } else if (t > 56) {
      bossRings.clear();
    }

    if (t >= 72) {
      worldContainer.removeChild(overlay);   overlay.destroy();
      worldContainer.removeChild(bolt);      bolt.destroy();
      worldContainer.removeChild(bossRings); bossRings.destroy();
      app.ticker.remove(tick);
    }
  };
  app.ticker.add(tick);

  // 750ms 후 360° 파티클 폭발 — 속성별 형태 분기
  setTimeout(() => {
    const cfg = ELEMENT_VFX[element];
    for (let i = 0; i < 48; i++) {
      const a  = (i / 48) * Math.PI * 2;
      const ex = bx + Math.cos(a) * 90;
      const ey = by + Math.sin(a) * 90;
      if (cfg) {
        emitParticles(ex, ey, c,     6, 5.5, false, { shape: cfg.shape, gravity: cfg.gravity * 0.5 });
        emitParticles(ex, ey, cfg.secondColor, 3, 4.5, false, cfg.secondOpts);
      } else {
        emitParticles(ex, ey, c,        6, 5.5, false, { shape: 'circle', gravity: 0.08 });
        emitParticles(ex, ey, 0xff6600, 3, 4.0, false, { shape: 'ember',  gravity: 0.20 });
      }
    }
    // 중심 대폭발
    emitParticles(bx, by, 0xffffff, 24, 14, false, { shape: 'circle', gravity: 0.04, decay: [0.025, 0.050] });
    emitParticles(bx, by, cGlow,   20, 10, false, { shape: 'circle', gravity: 0.10, sizeRange: [4, 10] });
  }, 750);
}

function vfxPlayerDie(px, py, element) {
  cameraShake(8, 400);
  const c = elemColor(element);
  let t = 0;
  const ring = new PIXI.Graphics();
  worldContainer.addChild(ring);
  const tick = () => {
    t++;
    ring.clear();
    ring.circle(px, py, t*14).stroke({ color: c, width: 4, alpha: Math.max(0, 1-t/22) });
    if (t >= 24) { worldContainer.removeChild(ring); ring.destroy(); app.ticker.remove(tick); }
  };
  app.ticker.add(tick);
  for (let i = 0; i < 5; i++)
    setTimeout(() => emitParticles(px, py, c, 18, 7), i * 80);
}

function vfxEnemyDie(ex, ey, element) {
  if (element) {
    emitElementParticles(ex, ey, element, 16, null);
  } else {
    emitParticles(ex, ey, 0x88ff88, 14, 5, false, { shape: 'circle', gravity: 0.14 });
  }
  emitParticles(ex, ey, 0xffffff, 5, 8, false, { shape: 'circle', gravity: 0.08, decay: [0.040, 0.070] });
}

// ── 마법진 확정 플래시 (Goal 1 — 도형→주문 전환 시각 확정 신호, 100ms 내 체감) ──
// spellFxContainer에 직접 추가(z-order: gameGfx 위, particles 아래)
function vfxMagicCircle(x, y, element, spellType) {
  const c = elemColor(element);
  // 주문 타입별 다각형 꼭짓점 수: 원→4, 삼각→3, 별→5, 사각→6, 지그재그→8
  const N = { bolt: 4, pierce: 3, nova: 5, pulse: 6, chain: 8 }[spellType] ?? 4;
  const ring = new PIXI.Graphics();
  spellFxContainer.addChild(ring);
  let t = 0;
  const tick = () => {
    t++;
    ring.clear();
    const progress = t / 20;
    const a        = Math.max(0, 1 - progress);
    const r        = 14 + t * 5.5;
    // 확산 링
    ring.circle(x, y, r).stroke({ color: c, width: 2.5, alpha: a * 0.9 });
    // 중앙 코어 플래시 (초반에만)
    if (t <= 5) {
      const coreA = (5 - t) / 5;
      ring.circle(x, y, r * 0.4).fill({ color: c, alpha: coreA * 0.45 });
    }
    // 회전하는 속성별 꼭짓점 점
    for (let i = 0; i < N; i++) {
      const ang = (i / N) * Math.PI * 2 + t * 0.20;
      const px2 = x + Math.cos(ang) * r;
      const py2 = y + Math.sin(ang) * r;
      ring.circle(px2, py2, 2.8 * a).fill({ color: c, alpha: a });
    }
    // 보조 내부 링 (절반 속도 확산)
    if (t >= 4) {
      const innerA = Math.max(0, 0.55 - progress * 0.8);
      ring.circle(x, y, r * 0.6).stroke({ color: 0xffffff, width: 1, alpha: innerA });
    }
    if (t >= 22) { spellFxContainer.removeChild(ring); ring.destroy(); app.ticker.remove(tick); }
  };
  app.ticker.add(tick);
}

// ── Off-Screen Enemy Indicators ───────────────────────────────────────────────
function renderIndicators() {
  indicatorGfx.clear();
  if (!gameState || !['playing','wave_clear','wave_prep'].includes(gameState.phase)) return;

  const cx = GAME_W / 2, cy = GAME_H / 2;
  const m  = 22;   // edge margin (px)
  const sz = 11;   // arrow half-length

  for (const e of (gameState.enemies || [])) {
    if (!e.alive) continue;
    const sp = smoothPos['e_' + e.id];
    const ex = sp ? sp.x : e.x;
    const ey = sp ? sp.y : e.y;

    // Only draw indicator if enemy is fully outside the visible canvas
    if (ex >= 0 && ex <= GAME_W && ey >= 0 && ey <= GAME_H) continue;

    const dx = ex - cx, dy = ey - cy;
    let t = Infinity;
    if (dx > 0) t = Math.min(t, (GAME_W - m - cx) / dx);
    if (dx < 0) t = Math.min(t, (m       - cx) / dx);
    if (dy > 0) t = Math.min(t, (GAME_H - m - cy) / dy);
    if (dy < 0) t = Math.min(t, (m       - cy) / dy);
    if (!isFinite(t) || t <= 0) continue;

    const ix  = cx + dx * t;
    const iy  = cy + dy * t;
    const ang = Math.atan2(dy, dx);
    const cos = Math.cos(ang), sin = Math.sin(ang);
    const c   = ENEMY_COLORS[e.type] ?? 0xaaaaaa;

    // Filled arrow triangle pointing toward enemy
    indicatorGfx.poly([
      ix + cos * sz,                             iy + sin * sz,
      ix - cos * sz * 0.7 + sin * sz * 0.55,   iy - sin * sz * 0.7 - cos * sz * 0.55,
      ix - cos * sz * 0.7 - sin * sz * 0.55,   iy - sin * sz * 0.7 + cos * sz * 0.55,
    ]).fill({ color: c, alpha: 0.88 });
    // White center dot for visibility
    indicatorGfx.circle(ix - cos * sz * 0.18, iy - sin * sz * 0.18, 2.5)
      .fill({ color: 0xffffff, alpha: 0.75 });
  }
}

// ── HUD Update ────────────────────────────────────────────────────────────────
function updateHUD(state) {
  const players = Object.values(state.players || {});
  const p1 = players.find(p => p.index === 0);
  const p2 = players.find(p => p.index === 1);

  const applyPl = (pfx, pl) => {
    if (!pl) return;
    const hp = document.getElementById(pfx+'-hp');
    const mp = document.getElementById(pfx+'-mp');
    if (!hp) return;
    hp.style.width = (100 * pl.hp / pl.maxHp)   + '%';
    mp.style.width = (100 * pl.mana / pl.maxMana) + '%';
    const expEl = document.getElementById(pfx+'-exp');
    if (expEl && pl.expToNext > 0) expEl.style.width = (100 * pl.exp / pl.expToNext) + '%';
    hp.style.opacity = pl.alive ? '1' : '0.35';
    document.getElementById(pfx+'-lv').textContent = `Lv.${pl.level}`;
    const tag = document.getElementById(pfx+'-eltag');
    tag.textContent  = ELEMENT_EMOJI[pl.element] ?? '?';
    tag.className    = `el-tag ${pl.element ?? ''}`;
    document.getElementById(pfx+'-disc').classList.toggle('hidden', pl.connected !== false);

    // Skill dots: element dots (colored) + passive dots (gold)
    const skls = document.getElementById(pfx+'-skills');
    const elemDots = (pl.elements||[]).map(el => {
      const c = elemHex(el);
      return `<div class="skill-dot" style="background:${c};box-shadow:0 0 4px ${c}" title="${ELEMENT_NAMES[el]||el}"></div>`;
    }).join('');
    const passDots = (pl.passives||[]).map(() =>
      `<div class="skill-dot" style="background:#ffaa22;box-shadow:0 0 4px #ffaa22"></div>`
    ).join('');
    skls.innerHTML = elemDots + passDots;
  };
  applyPl('p1', p1);
  applyPl('p2', p2);
  document.getElementById('wave-badge').textContent = `WAVE ${state.wave?.number ?? 1}`;
  document.getElementById('score-val').textContent  = (state.score ?? 0).toLocaleString() + ' pts';
}

// ── Screen Management ─────────────────────────────────────────────────────────
const GAME_SCREENS = ['lobby-screen','countdown-screen','game-hud','gameover-screen'];

function showScreen(id) {
  for (const sid of GAME_SCREENS) {
    document.getElementById(sid)?.classList.toggle('hidden', sid !== id);
  }
  // Augment screen is managed separately; always hide it on any screen switch
  document.getElementById('augment-screen')?.classList.add('hidden');
}

function showAdvisor(message, priority, confidence) {
  const panel = document.getElementById('advisor-panel');
  document.getElementById('adv-icon').className = `adv-icon ${priority}`;
  document.getElementById('adv-icon').textContent = priority==='high'?'⚠':priority==='med'?'●':'ℹ';
  document.getElementById('adv-msg').textContent  = message;
  document.getElementById('adv-conf').textContent = Number.isFinite(confidence) && confidence >= 0.7
    ? `${Math.round(confidence*100)}%` : '(저신뢰)';
  panel.classList.remove('hidden');
  panel.style.opacity = Number.isFinite(confidence) && confidence < 0.7 ? '0.5' : '1';
  if (advisorTimer) clearTimeout(advisorTimer);
  advisorTimer = setTimeout(() => panel.classList.add('hidden'), 6500);
}

// ── ML Fallback Notice ────────────────────────────────────────────────────────
// "추정값 사용 중" 표시 — 서킷 브레이커 작동 시 2.5초 후 자동 소멸
let fallbackNoticeTimer = null;
function showFallbackNotice() {
  let el = document.getElementById('ml-fallback-notice');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ml-fallback-notice';
    // 오렌지 배너 — advisor(파랑·노랑·빨강)와 색으로 즉각 구별
    el.style.cssText = [
      'position:fixed',
      'top:16px',
      'left:50%',
      'transform:translateX(-50%)',
      'background:rgba(180,70,5,0.92)',
      'color:#fff4cc',
      'font-size:13px',
      'font-weight:700',
      'padding:6px 20px',
      'border-radius:20px',
      'pointer-events:none',
      'z-index:999',
      'display:flex',
      'align-items:center',
      'gap:7px',
      'box-shadow:0 0 14px rgba(255,100,0,0.55)',
      'transition:opacity 0.4s ease',
    ].join(';');
    el.innerHTML = '⚙ 추정값 사용 중';
    (document.getElementById('overlay') ?? document.body).appendChild(el);
  }
  el.style.opacity = '1';
  el.style.display = 'flex';
  if (fallbackNoticeTimer) clearTimeout(fallbackNoticeTimer);
  fallbackNoticeTimer = setTimeout(() => { el.style.opacity = '0'; }, 2500);
}

function showCountdown(seconds) {
  const scr = document.getElementById('countdown-screen');
  scr.classList.remove('hidden');
  let n = seconds;
  const tick = () => {
    scr.innerHTML = `<div class="countdown-num">${n}</div>`;
    n--;
    if (n >= 0) setTimeout(tick, 900);
    else { setTimeout(() => scr.classList.add('hidden'), 900); }
  };
  tick();
}

// ── WASD 힌트 오버레이 (게임 시작 후 3초) ───────────────────────────────────────
let _wasdHintTimer = null;
function showWasdHint() {
  const el = document.getElementById('wasd-hint');
  if (!el) return;
  if (_wasdHintTimer) clearTimeout(_wasdHintTimer);
  el.classList.add('visible');
  _wasdHintTimer = setTimeout(() => {
    el.classList.remove('visible');
    _wasdHintTimer = null;
  }, 3000);
}

// ── 피격 방향 플래시 ────────────────────────────────────────────────────────────
let _hitFlashTimer = null;
function showHitFlash(direction) {
  const el = document.getElementById('hit-flash');
  if (!el) return;
  if (_hitFlashTimer) clearTimeout(_hitFlashTimer);
  el.className = `flash-${direction} active`;
  _hitFlashTimer = setTimeout(() => {
    el.classList.remove('active');
    _hitFlashTimer = null;
  }, 220);
}
// direction: 공격자→피격자 벡터로 피격 방향(화면 어느 쪽에서 왔나) 결정
function hitDirection(attackerPos, targetPos) {
  if (!attackerPos || !targetPos) return 'top';
  const dx = targetPos.x - attackerPos.x;
  const dy = targetPos.y - attackerPos.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'bottom' : 'top';
}

// ── Wave Prep Countdown Overlay ───────────────────────────────────────────────
let _wavePrepInterval = null;

// ENEMY_LABELS: 서버 type key → 한국어 표시명 (데이터 드리븐 locale 맵)
const ENEMY_LABELS = {
  basic:  '기본',
  fast:   '빠른',
  tank:   '탱커',
  ranged: '원거리',
  boss:   '보스',
  shield: '방패',
  healer: '힐러',
};

function showWavePrepCountdown(seconds, eventType, nextEnemies) {
  if (_wavePrepInterval) { clearInterval(_wavePrepInterval); _wavePrepInterval = null; }
  const overlay = document.getElementById('wave-prep-overlay');
  const timerEl = document.getElementById('wave-prep-timer');
  const nextEl  = document.getElementById('wave-prep-next');
  const eventEl = document.getElementById('wave-prep-event');
  if (!overlay) return;

  let remaining = Math.max(1, seconds);
  timerEl.textContent = remaining;
  nextEl.textContent  = '다음 웨이브 준비 중';
  if (eventType === 'elemental_surge') {
    eventEl.textContent = '⚡ 원소 폭풍 웨이브 예고!';
    eventEl.classList.add('visible');
  } else {
    eventEl.textContent = '';
    eventEl.classList.remove('visible');
  }

  // ⑤ next_enemies 미리보기 렌더
  const enemiesEl = document.getElementById('wave-prep-enemies');
  if (enemiesEl) {
    if (Array.isArray(nextEnemies) && nextEnemies.length > 0) {
      enemiesEl.innerHTML = nextEnemies.map(e => {
        const label  = ENEMY_LABELS[e.type] ?? e.type;
        const emoji  = ELEMENT_EMOJI[e.element] ?? '';
        const elCls  = e.element ? `el-${e.element}` : '';
        return `<span class="enemy-pill ${elCls}">` +
          (emoji ? `<span class="ep-elem">${emoji}</span>` : '') +
          `<span>${label}</span>` +
          `<span class="ep-count">×${e.count}</span>` +
          `</span>`;
      }).join('');
    } else {
      enemiesEl.innerHTML = '';
    }
  }

  overlay.classList.add('visible');

  _wavePrepInterval = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(_wavePrepInterval); _wavePrepInterval = null;
      overlay.classList.remove('visible');
    } else {
      timerEl.textContent = remaining;
    }
  }, 1000);
}

function hideWavePrepCountdown() {
  if (_wavePrepInterval) { clearInterval(_wavePrepInterval); _wavePrepInterval = null; }
  document.getElementById('wave-prep-overlay')?.classList.remove('visible');
}

// ── Lobby Panel States ────────────────────────────────────────────────────────
function setLobbyPanel(panel) {
  for (const id of ['lobby-init','lobby-join','lobby-waiting','lobby-joined','lobby-rooms']) {
    document.getElementById(id)?.classList.toggle('hidden', id !== panel);
  }
}

function updateRoomPlayerCount(count) {
  const el = document.getElementById('player-count-line');
  if (el) el.textContent = `플레이어: ${count} / 2명`;
  const btn = document.getElementById('btn-start');
  if (btn) btn.textContent = count >= 2 ? '▶ 게임 시작 (2인)' : '▶ 게임 시작 (솔로)';
}

// ── Augment Screen ────────────────────────────────────────────────────────────
function showAugmentScreen(options, level) {
  document.getElementById('aug-level-display').textContent = `Lv. ${level} 달성`;
  const container = document.getElementById('aug-cards');
  container.innerHTML = '';

  options.forEach(opt => {
    const card = document.createElement('div');
    card.className = `aug-card kind-${opt.kind}`;

    // Icon
    let icon = '✦';
    let badge = '';
    if (opt.kind === 'element') {
      icon = ELEMENT_EMOJI[opt.id] ?? '✦';
      badge = '속성';
    } else if (opt.kind === 'stat') {
      icon = opt.label?.[0] ?? '⚔';
      badge = '스탯';
    } else if (opt.kind === 'passive') {
      icon = '✦';
      badge = '패시브';
    }

    card.innerHTML = `
      <div class="aug-card-badge">${badge}</div>
      <div class="aug-card-icon">${icon}</div>
      <div class="aug-card-label">${opt.label ?? opt.id}</div>
      <div class="aug-card-desc">${opt.desc ?? ''}</div>
    `;

    card.addEventListener('click', () => {
      sendWS({ type: 'select_augment', index: opt.index });
      hideAugmentScreen();
    });

    container.appendChild(card);
  });

  document.getElementById('augment-screen').classList.remove('hidden');
}

function hideAugmentScreen() {
  document.getElementById('augment-screen').classList.add('hidden');
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function sendWS(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function onMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  switch (msg.type) {

    case 'connected':
      myPlayerId = msg.playerId;
      sessionStorage.setItem('wdPlayerId', myPlayerId);
      // 서버에서 내려온 drawingConfig 저장 — 클라이언트 하드코딩 0.65 대체
      // 스키마: { confidenceTiers: [{min,max,damageMult,label}…], minPassThreshold: number }
      window.drawingConfig = msg.drawingConfig ?? null;
      // Show lobby init state
      showScreen('lobby-screen');
      setLobbyPanel('lobby-init');
      document.getElementById('lobby-connect-status').textContent = '연결됨';
      break;

    case 'room_created':
      myRoomCode = msg.roomCode;
      isHost = true;
      myPlayerId = msg.playerId;
      myPlayerIndex = msg.playerIndex;
      sessionStorage.setItem('wdPlayerId', msg.playerId);
      document.getElementById('room-code-display').textContent = msg.roomCode;
      setLobbyPanel('lobby-waiting');
      updateRoomPlayerCount(1);
      break;

    case 'room_joined':
      myRoomCode = msg.roomCode;
      isHost = false;
      myPlayerId = msg.playerId;
      myPlayerIndex = msg.playerIndex;
      sessionStorage.setItem('wdPlayerId', msg.playerId);
      if (msg.isHost) {
        document.getElementById('room-code-display').textContent = msg.roomCode;
        setLobbyPanel('lobby-waiting');
      } else {
        setLobbyPanel('lobby-joined');
      }
      updateRoomPlayerCount(msg.playerCount ?? 2);
      break;

    case 'room_error': {
      const errEl = document.getElementById('join-error');
      const msgs = {
        room_not_found: '방을 찾을 수 없습니다',
        game_already_started: '이미 게임이 시작된 방입니다',
        room_full: '방이 가득 찼습니다',
        not_host: '호스트만 시작할 수 있습니다',
      };
      const errMsg = msgs[msg.message] ?? `오류: ${msg.message}`;
      // If user is in rooms panel, refresh the list (room may be full/started now)
      const roomsPanel = document.getElementById('lobby-rooms');
      if (roomsPanel && !roomsPanel.classList.contains('hidden')) {
        const countEl = document.getElementById('rooms-count');
        if (countEl) countEl.textContent = errMsg;
        fetchAndRenderRooms();
      } else if (errEl) {
        errEl.textContent = errMsg;
        errEl.classList.remove('hidden');
      }
      break;
    }

    case 'player_joined':
      updateRoomPlayerCount(msg.playerCount ?? 2);
      break;

    case 'player_left':
      updateRoomPlayerCount(msg.playerCount ?? 1);
      break;

    case 'host_changed':
      if (msg.newHostId === myPlayerId) isHost = true;
      break;

    case 'countdown':
      // 새 게임 시작 시 세션 통계 리셋
      sessionKills = 0; sessionCurrentCombo = 0; sessionMaxCombo = 0; sessionLastKillTime = 0;
      setBossWaveVisuals(false);
      // 일시정지·dying enemies 초기화
      isPaused = false;
      document.getElementById('pause-overlay')?.classList.remove('visible');
      dyingEnemies.clear();
      showScreen('countdown-screen');
      showCountdown(msg.seconds);
      break;

    case 'wave_start':
      hideWavePrepCountdown();
      showScreen('game-hud');
      document.getElementById('wave-badge').textContent  =
        `WAVE ${msg.waveNumber}${msg.eventType === 'elemental_surge' ? ' ⚡' : ''}`;
      document.getElementById('score-val').textContent   = '0 pts';
      vfxWaveStart(msg.waveNumber, msg.hasBoss);
      playSound('wave_start');
      // Goal 3: 보스 파동 배경 색온도 전환
      setBossWaveVisuals(!!msg.hasBoss);
      // Goal 4: DDA 배율 표시 (±5% 이상일 때만)
      if (msg.ddaScale && Math.abs(msg.ddaScale - 1.0) >= 0.05) {
        const isUp = msg.ddaScale > 1.0;
        const ddaTxt = isUp ? `▲ 강화 ×${msg.ddaScale.toFixed(2)}` : `▼ 완화 ×${msg.ddaScale.toFixed(2)}`;
        showFloatText(GAME_W / 2, GAME_H / 2 + 56, ddaTxt, isUp ? '#ff8844' : '#44ccff');
      }
      if (msg.eventType === 'elemental_surge') {
        setTimeout(() => showFloatText(GAME_W / 2, GAME_H / 2 - 80, '⚡ 원소 폭풍!', '#ffaa44'), 400);
      }
      // ④ WASD 힌트 오버레이: 게임 시작 후 3초 표시
      if (msg.waveNumber === 1) showWasdHint();
      break;

    case 'wave_clear':
      vfxWaveClear();
      // Goal 3: 보스 파동 종료 → 배경 복원
      setBossWaveVisuals(false);
      break;

    case 'wave_prep': {
      const nw  = msg.nextWave ?? 1;
      const sec = msg.countdown ?? msg.prepSeconds ?? 5;
      // Derive event type client-side (matches server logic: wave%3===0, not boss wave at %5)
      const isSurge = (nw % 3 === 0) && (nw % 5 !== 0);
      // ⑤ next_enemies: 서버가 보낸 다음 웨이브 적 구성 미리보기
      showWavePrepCountdown(sec, isSurge ? 'elemental_surge' : null, msg.next_enemies ?? null);
      break;
    }

    case 'boss_spawn': {
      const bx = (gameState?.enemies||[]).find(en=>en.id===msg.enemyId)?.x ?? GAME_W/2;
      const by = (gameState?.enemies||[]).find(en=>en.id===msg.enemyId)?.y ?? GAME_H/2;
      vfxBossSpawn(bx, by, msg.element);
      break;
    }

    case 'level_up': {
      const pl = gameState?.players?.[msg.playerId];
      if (pl) vfxLevelUp(pl.x, pl.y, pl.element);
      // EXP bar: flash 100% then animate down to 0% for "level-up" feel
      const lvPl = Object.values(gameState?.players ?? {}).find(p => p.id === msg.playerId);
      const lvPfx = lvPl?.index === 0 ? 'p1' : 'p2';
      const lvExpEl = document.getElementById(lvPfx + '-exp');
      if (lvExpEl) {
        lvExpEl.style.transition = 'none';
        lvExpEl.style.width = '100%';
        setTimeout(() => { lvExpEl.style.transition = 'width 0.35s ease-out'; lvExpEl.style.width = '0%'; }, 50);
      }
      playSound('level_up');
      break;
    }

    case 'augment_options':
      // Show augment selection screen
      showAugmentScreen(msg.options, msg.level);
      break;

    case 'augment_selected': {
      hideAugmentScreen();
      // Update local skill dot state from playerStats if available
      if (msg.playerId === myPlayerId && msg.playerStats && gameState?.players?.[myPlayerId]) {
        const pl = gameState.players[myPlayerId];
        if (msg.playerStats.elements) pl.elements = msg.playerStats.elements;
        if (msg.playerStats.passives) pl.passives = msg.playerStats.passives;
        if (msg.playerStats.element)  pl.element  = msg.playerStats.element;
        updateHUD(gameState);
      }
      // Float notification
      if (msg.option) {
        const pl = gameState?.players?.[msg.playerId];
        if (pl) showFloatText(pl.x, pl.y - 30, `✦ ${msg.option.label}`, '#ffaa22');
      }
      break;
    }

    case 'player_die': {
      const pl = gameState?.players?.[msg.playerId];
      vfxPlayerDie(pl?.x ?? GAME_W/2, pl?.y ?? GAME_H/2, pl?.element);
      break;
    }

    case 'enemy_die': {
      const e = (gameState?.enemies??[]).find(e=>e.id===msg.enemyId);
      if (e) {
        // Snapshot for fade-out; remove immediately so no double-render with dying overlay
        dyingEnemies.set(msg.enemyId, { x: e.x, y: e.y, r: e.radius ?? 18, type: e.type, element: e.element, startTime: performance.now() });
        if (gameState?.enemies) gameState.enemies = gameState.enemies.filter(en => en.id !== msg.enemyId);
        vfxEnemyDie(e.x, e.y, msg.element);
      }
      // Goal 8: 클라이언트 킬/콤보 추적
      {
        const now = performance.now();
        const COMBO_WINDOW = 1800;
        if (now - sessionLastKillTime <= COMBO_WINDOW) {
          sessionCurrentCombo++;
        } else {
          sessionCurrentCombo = 1;
        }
        sessionLastKillTime = now;
        sessionMaxCombo = Math.max(sessionMaxCombo, sessionCurrentCombo);
        sessionKills++;
      }
      break;
    }

    case 'spell_result': {
      // Goal 1: 실패 시 "인식 중..." 오버레이 즉시 제거
      if (!msg.success) hideSpellOverlay();
      // confidence 정규화: null/undefined/문자열 → NaN (Number(null)===0 버그 차단)
      const rawConf = msg.confidence;
      const normConf = (typeof rawConf === 'number' && isFinite(rawConf)) ? rawConf : NaN;

      // ML 서킷 브레이커 fallback 수신 시 오렌지 배너 즉시 표시
      if (msg.fallback === true) showFallbackNotice();

      const tierLabel = msg.tier ?? '';
      // 티어별 색상 토큰 (서버가 보낸 label 기반 — 하드코딩 임계값 없음)
      const tierColor = tierLabel === '완벽' ? 'gold'
                      : tierLabel === '정상' ? 'white'
                      : tierLabel === '약화' ? 'gray'
                      : null;
      if (msg.success) {
        flashTrail(drawPoints.slice(), true, tierColor);
        const pl = gameState?.players?.[myPlayerId];
        if (pl) {
          emitParticles(pl.x, pl.y, elemColor(msg.element), 16, 5);
          // Float text: tier label
          const cssColor = tierColor === 'gold'  ? '#ffcc00'
                         : tierColor === 'white' ? '#e0eeff'
                         : tierColor === 'gray'  ? '#889aaa'
                         : '#aaaaaa';
          const displayText = msg.isComposite
            ? `✨ ${msg.label ?? '복합 마법'}`
            : (tierLabel ? `${tierLabel}! ${msg.label ?? ''}` : msg.label ?? '');
          if (displayText) showFloatText(pl.x, pl.y - 28, displayText, cssColor);
        }
        // 약화 티어 성공 시 어드바이저 힌트 (0.65 하드코딩 제거 — 서버 tier label 사용)
        if (tierLabel === '약화') {
          showAdvisor('좀 더 명확하게 그려보세요 — 크고 또렷하게!', 'low',
            Number.isFinite(normConf) ? normConf : 0);
        }
      } else {
        flashTrail(drawPoints.slice(), false, null);
        cameraShake(4, 200);
        const pl = gameState?.players?.[myPlayerId];
        const reason = msg.reason;
        const confPct = Number.isFinite(normConf) ? Math.round(normConf * 100) + '%' : '?';
        const hintMap = {
          unrecognized: '인식 실패 — 원·삼각·사각·〜·★ 중 하나를 그리세요',
          ml_fallback:  '인식 서비스 일시 비활성 — 잠시 후 다시 시도하세요',
          no_mana:      '마나 부족! 잠시 기다리세요',
          cooldown:     '쿨다운 중!',
          failed_draw:  `그리기 약함 (신뢰도 ${confPct})`,
          no_spell:     '아직 해당 마법을 배우지 않았습니다',
        };
        const hintText = hintMap[reason] ?? '인식 실패';
        if (pl) showFloatText(pl.x, pl.y - 28, '✗ ' + (reason === 'unrecognized' || reason === 'ml_fallback' ? '인식 실패' : hintMap[reason] ?? '실패'), '#ff5544');
        showAdvisor(hintText, reason === 'unrecognized' ? 'low' : 'med',
          Number.isFinite(normConf) ? normConf : 0);
      }
      drawPoints = [];
      break;
    }

    case 'shape_recognized': {
      // Immediate shape recognition feedback — re-color the trail
      const shapeColor = {
        circle: [80, 180, 255],
        triangle: [255, 140, 40],
        square: [100, 220, 100],
        zigzag: [255, 220, 0],
        star: [255, 80, 220],
      };
      const [r, g, b] = shapeColor[msg.shape] ?? [200, 220, 255];
      renderTrail(drawPoints, r, g, b, 0.95);
      break;
    }

    case 'spell_cast': {
      // 속성별 파티클(3채널) + 마법진 확정 플래시(100ms 내 체감 SLA)
      emitElementParticles(msg.x, msg.y, msg.element, 10, null);
      vfxMagicCircle(msg.x, msg.y, msg.element, msg.spellType);
      // Extra VFX for composite
      if (msg.isComposite) {
        emitParticles(msg.x, msg.y, 0xffffff, 14, 7, false, { shape: 'circle', gravity: 0.06, decay: [0.020, 0.040] });
        cameraShake(3, 200);
      }
      // Goal 1: 주문 타입 오버레이 표시
      if (msg.playerId === myPlayerId) {
        // 내 주문: 중앙 오버레이에 크게 표시
        showSpellName(msg.spellType, msg.element);
      } else {
        // 상대 주문: 플레이어 위에 float text
        const spellLabel = `${SPELL_EMOJI[msg.spellType] ?? '✦'} ${SPELL_NAMES[msg.spellType] ?? msg.spellType}`;
        showFloatText(msg.x, (msg.y ?? 0) - 44, spellLabel, elemHex(msg.element) ?? '#ffffff');
      }
      break;
    }

    case 'hit': {
      if (msg.isEnemy === true) {
        const enemy = (gameState?.enemies ?? []).find(en => en.id === msg.targetId);
        // Immediately update client-side HP for instant bar refresh (server authority)
        if (enemy && msg.damage > 0) enemy.hp = Math.max(0, enemy.hp - msg.damage);
        const px = msg.pos?.x ?? enemy?.x;
        const py = msg.pos?.y ?? enemy?.y;
        if (enemy && px != null) {
          playSound('hit');
          // 시전 속성(msg.element)으로 VFX 분기 — 텍스트 없이 속성 즉각 식별
          if (msg.element) {
            emitElementParticles(px, py, msg.element, 10, null);
          } else {
            const ec = enemy.element ? elemColor(enemy.element) : (ENEMY_COLORS[enemy.type] ?? 0x88ff88);
            emitParticles(px, py, ec, 8, 5, false, { shape: 'circle', gravity: 0.14 });
          }
          emitParticles(px, py, 0xffffff, 3, 10, false, { shape: 'circle', gravity: 0.06, decay: [0.040, 0.070], sizeRange: [2, 4] });
          // Damage float text — combo hits use gold color
          if (msg.damage > 0) {
            const dmgColor = msg.combo ? '#ffcc00' : '#ff9944';
            showFloatText(px, py - 12, String(msg.damage), dmgColor);
          }
        }
      } else if (msg.targetId) {
        const pl  = gameState?.players?.[msg.targetId];
        const px  = msg.pos?.x ?? pl?.x;
        const py  = msg.pos?.y ?? pl?.y;
        if (px != null) {
          emitParticles(px, py, 0xffffff, 6, 4);
          cameraShake(4, 180);
          // ④ 방향 플래시: 내 플레이어가 피격됐을 때만
          if (msg.targetId === myPlayerId) {
            const dir = hitDirection(msg.attackerPos, msg.pos ?? { x: px, y: py });
            showHitFlash(dir);
          }
        }
      }
      break;
    }

    case 'co_combo_hit': {
      const { pos, comboDamageMult, elementalSurge } = msg;
      if (pos) {
        emitParticles(pos.x, pos.y, 0xffcc00, 20, 9);
        emitParticles(pos.x, pos.y, 0xff8800, 10, 6);
        if (elementalSurge) {
          // elemental_surge 조합 — 추가 파티클 + 보라 강조
          emitParticles(pos.x, pos.y, 0xee44ff, 16, 11);
          cameraShake(8, 300);
          const totalMult = ((comboDamageMult ?? 1.35) * elementalSurge.mult).toFixed(2);
          showFloatText(pos.x, pos.y - 50, `⚡ CO-COMBO ×${totalMult}`, '#ff88ff');
          showFloatText(pos.x, pos.y - 26, `SURGE: ${elementalSurge.key}`, '#ffaaff');
        } else {
          cameraShake(5, 240);
          const mult = (comboDamageMult ?? 1.35).toFixed(2);
          showFloatText(pos.x, pos.y - 38, `★ CO-COMBO ×${mult}`, '#ffcc00');
        }
      }
      break;
    }

    // Goal 6: 2P 협동 시너지 버스트 VFX — 조합별 3채널 분기
    case 'co_synergy_burst': {
      const cs1  = elemColor(msg.elem1);
      const cs2  = elemColor(msg.elem2 ?? msg.elem1);
      const elem1 = msg.elem1 ?? 'fire';
      const elem2 = msg.elem2 ?? msg.elem1 ?? 'fire';
      // 조합 키: 알파벳 정렬로 정규화 (순서 무관)
      const comboKey = [elem1, elem2].sort().join('+');
      // 조합별 파티클 파라미터 — 색·형태·중력 3채널 동시 분기
      const SYNERGY_BURST = {
        'fire+lightning': { s1: 'ember', g1: 0.22, s2: 'spark',  g2: 0.00, extra: 0xfffacc, shakeStr: 17, extraShape: 'spark'  },
        'fire+water':     { s1: 'ember', g1: 0.25, s2: 'circle', g2: 0.02, extra: 0xddffee, shakeStr: 13, extraShape: 'circle' },
        'fire+earth':     { s1: 'ember', g1: 0.30, s2: 'square', g2: 0.32, extra: 0xff8800, shakeStr: 15, extraShape: 'square' },
        'lightning+water':{ s1: 'spark', g1: 0.00, s2: 'circle', g2: 0.03, extra: 0xccaaff, shakeStr: 16, extraShape: 'spark'  },
        'earth+lightning':{ s1: 'square',g1: 0.28, s2: 'spark',  g2: 0.01, extra: 0xffee88, shakeStr: 14, extraShape: 'spark'  },
        'earth+water':    { s1: 'square',g1: 0.30, s2: 'circle', g2: 0.02, extra: 0x88ffcc, shakeStr: 12, extraShape: 'circle' },
      };
      const bp = SYNERGY_BURST[comboKey] ?? { s1: 'circle', g1: 0.14, s2: 'circle', g2: 0.14, extra: 0xffffff, shakeStr: 13, extraShape: 'circle' };
      // elem1·elem2 각각 속성별 형태+중력 파티클
      emitParticles(msg.x, msg.y, cs1, 38, 13, false, { shape: bp.s1, gravity: bp.g1, sizeRange: [4, 9] });
      emitParticles(msg.x, msg.y, cs2, 38, 13, false, { shape: bp.s2, gravity: bp.g2, sizeRange: [4, 9] });
      // 조합 고유 중간 색 파티클
      emitParticles(msg.x, msg.y, bp.extra, 28, 17, false, { shape: bp.extraShape, gravity: 0.05, sizeRange: [3, 7], decay: [0.018, 0.038] });
      cameraShake(bp.shakeStr, 500);
      // 이중 속성 확산 링
      const sRing = new PIXI.Graphics();
      worldContainer.addChild(sRing);
      let sr = 0;
      const sRingTick = () => {
        sr++;
        sRing.clear();
        const a1 = Math.max(0, 1 - sr / 38);
        const a2 = Math.max(0, 0.7 - sr / 38);
        sRing.circle(msg.x, msg.y, sr * 14).stroke({ color: cs1, width: 4, alpha: a1 });
        sRing.circle(msg.x, msg.y, sr * 9).stroke({ color: cs2, width: 2.5, alpha: a2 });
        if (sr >= 40) { worldContainer.removeChild(sRing); sRing.destroy(); app.ticker.remove(sRingTick); }
      };
      app.ticker.add(sRingTick);
      // 시너지 텍스트
      const sn1 = ELEMENT_NAMES[msg.elem1] ?? msg.elem1;
      const sn2 = ELEMENT_NAMES[msg.elem2] ?? msg.elem2;
      showFloatText(msg.x, msg.y - 68, `⚡ 시너지: ${sn1}+${sn2}`, '#fff5aa');
      showFloatText(msg.x, msg.y - 34, `+${msg.dmg} BURST`, '#ffffff');
      break;
    }

    // Goal 8: 리더보드 수신 → 게임 오버 화면 갱신
    case 'leaderboard': {
      const entries = msg.entries ?? [];
      // 현재 세션에 가장 가까운 항목(wave 일치 우선, 없으면 0번째)
      const curWave = parseInt(document.getElementById('over-wave')?.textContent ?? '0', 10);
      const myEntry = entries.find(e => e.wave === curWave) ?? entries[0];
      if (myEntry) {
        const killsEl = document.getElementById('over-kills');
        const comboEl = document.getElementById('over-combo');
        if (killsEl) killsEl.textContent = myEntry.kills;
        if (comboEl) comboEl.textContent = myEntry.maxCombo;
      }
      // 리더보드 목록 렌더
      const lbList    = document.getElementById('leaderboard-list');
      const lbSection = document.getElementById('leaderboard-section');
      if (lbList && entries.length > 0) {
        lbList.innerHTML = entries.map((e, i) => {
          const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`;
          const names = Array.isArray(e.playerNames) && e.playerNames.length ? e.playerNames.join(', ') : '?';
          const scoreStr = typeof e.score === 'number' ? e.score.toLocaleString() : '?';
          return `<div class="lb-row">` +
            `<span class="lb-rank">${medal}</span>` +
            `<span class="lb-wave" style="flex:none;width:72px">WAVE ${e.wave}</span>` +
            `<span style="flex:1;color:#ccddee;font-size:11px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${names}</span>` +
            `<span style="width:74px;text-align:right;color:#ffee88;font-weight:700">${scoreStr}pts</span>` +
            `<span class="lb-kills">${e.kills}킬</span>` +
            `</div>`;
        }).join('');
        if (lbSection) lbSection.style.display = 'block';
      }
      break;
    }

    case 'solo_combo_hit': {
      // ① 솔로 콤보 피드백 — 내 플레이어에게만 전달되는 개인 이벤트
      if (msg.attackerId === myPlayerId) {
        const en = (gameState?.enemies ?? []).find(e => e.id === msg.targetId);
        const fx = en?.x ?? GAME_W / 2;
        const fy = en?.y ?? GAME_H / 2;
        emitParticles(fx, fy, 0xffdd44, 12, 7);
        cameraShake(3, 180);
        showFloatText(fx, fy - 38, `★ COMBO ×1.35`, '#ffdd44');
      }
      break;
    }

    case 'shield_defense': {
      // 방패 방어 진입/종료 — 서버 권위 판정 결과를 시각화
      if (msg.active) {
        const e = (gameState?.enemies ?? []).find(en => en.id === msg.enemyId);
        if (e) showFloatText(e.x, e.y - 36, '🛡 GUARD', '#88ccff');
      }
      break;
    }

    case 'advisor':
      showAdvisor(msg.message, msg.priority, msg.confidence ?? 1.0);
      break;

    case 'player_disconnect': {
      const pl = gameState?.players?.[msg.playerId];
      const pfx = pl?.index === 0 ? 'p1' : 'p2';
      document.getElementById(pfx+'-disc')?.classList.remove('hidden');
      break;
    }

    case 'state': {
      gameState = msg;
      if (msg.phase) sessionStorage.setItem('wdPhase', msg.phase);
      if (['playing','wave_clear','wave_prep'].includes(msg.phase)) {
        updateHUD(msg);
      }
      // Prune smoothPos for removed entities
      const alive = new Set([
        ...(msg.enemies  ||[]).map(e =>'e_'+e.id),
        ...(msg.spells   ||[]).map(s =>'s_'+s.id),
        ...(msg.projList ||[]).map(p =>'pr_'+p.id),
        ...Object.keys(msg.players||{}).map(id=>'p_'+id),
      ]);
      for (const k of Object.keys(smoothPos)) if (!alive.has(k)) delete smoothPos[k];
      break;
    }

    case 'game_over':
      playSound('game_over');
      hideWavePrepCountdown();
      sessionStorage.removeItem('wdPhase');
      hideAugmentScreen();
      setBossWaveVisuals(false);
      showScreen('gameover-screen');
      document.getElementById('over-wave').textContent  = msg.wave  ?? '?';
      document.getElementById('over-score').textContent = (msg.score??0).toLocaleString();
      // Goal 8: 클라이언트 집계 킬·콤보 즉시 표시
      document.getElementById('over-kills').textContent = sessionKills;
      document.getElementById('over-combo').textContent = sessionMaxCombo;
      // 닉네임 표시 (있으면)
      { const nickEl = document.getElementById('over-nickname'); if (nickEl) nickEl.textContent = myNickname || ''; }
      // 리더보드 섹션 숨겨두기 (leaderboard 이벤트 도착 후 표시됨)
      { const sec = document.getElementById('leaderboard-section'); if (sec) sec.style.display = 'none'; }
      break;

    case 'reconnected':
      myPlayerId    = msg.playerId;
      myPlayerIndex = msg.playerIndex;
      if (['playing','wave_clear','wave_prep'].includes(msg.phase)) showScreen('game-hud');
      break;

    case 'error':
      console.warn('[ws] server error:', msg.message);
      if (msg.message === 'session_not_found') {
        sessionStorage.removeItem('wdPlayerId');
        location.reload();
      }
      break;
  }
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);
  ws.onopen = () => {
    const savedId    = sessionStorage.getItem('wdPlayerId');
    const savedPhase = sessionStorage.getItem('wdPhase');
    const gamePhases = ['playing', 'wave_clear', 'wave_prep', 'countdown'];
    if (savedId && gamePhases.includes(savedPhase)) {
      sendWS({ type: 'reconnect', playerId: savedId });
    }
  };
  ws.onmessage = e => onMessage(e.data);
  ws.onclose   = () => setTimeout(connect, 3000);
  ws.onerror   = e => console.error('[ws]', e);
}

// ── Lobby Button Handlers ─────────────────────────────────────────────────────
document.getElementById('btn-create').addEventListener('click', () => {
  const rawNick = document.getElementById('nickname-input')?.value.trim() || '';
  myNickname = rawNick.slice(0, 16) || 'Player1';
  sendWS({ type: 'create_room', nickname: myNickname });
  document.getElementById('btn-create').disabled = true;
  document.getElementById('btn-create').textContent = '생성 중…';
});

document.getElementById('btn-join-show').addEventListener('click', () => {
  setLobbyPanel('lobby-join');
  document.getElementById('room-code-input').focus();
});

document.getElementById('btn-join-cancel').addEventListener('click', () => {
  setLobbyPanel('lobby-init');
  document.getElementById('join-error').classList.add('hidden');
});

document.getElementById('btn-join-confirm').addEventListener('click', () => {
  const code = document.getElementById('room-code-input').value.toUpperCase().trim();
  if (code.length < 4) {
    const errEl = document.getElementById('join-error');
    errEl.textContent = '4자리 코드를 입력하세요';
    errEl.classList.remove('hidden');
    return;
  }
  document.getElementById('join-error').classList.add('hidden');
  const rawNickJ = document.getElementById('nickname-input')?.value.trim() || '';
  myNickname = rawNickJ.slice(0, 16) || 'Player1';
  sendWS({ type: 'join_room', roomCode: code, nickname: myNickname });
});

document.getElementById('room-code-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-join-confirm').click();
});

document.getElementById('btn-start').addEventListener('click', () => {
  sendWS({ type: 'start_game' });
});

document.getElementById('btn-copy-code').addEventListener('click', () => {
  if (myRoomCode) {
    navigator.clipboard.writeText(myRoomCode).then(() => {
      const btn = document.getElementById('btn-copy-code');
      btn.textContent = '복사됨!';
      setTimeout(() => { btn.textContent = '복사'; }, 2000);
    });
  }
});

// ── Guide Panel Toggle ────────────────────────────────────────────────────────
let guideVisible = true;
document.getElementById('guide-toggle').addEventListener('click', () => {
  guideVisible = !guideVisible;
  document.getElementById('guide-body').classList.toggle('hidden', !guideVisible);
  document.getElementById('guide-arrow-icon').textContent = guideVisible ? '▼' : '▶';
});

// ── Main Ticker ───────────────────────────────────────────────────────────────
app.ticker.add(() => {
  // Camera shake
  if (shakeIntensity > 0) {
    const elapsed = performance.now() - shakeStart;
    if (elapsed < shakeDuration) {
      const fac = 1 - elapsed / shakeDuration;
      worldContainer.x = (Math.random()-.5) * shakeIntensity * 2 * fac;
      worldContainer.y = (Math.random()-.5) * shakeIntensity * 2 * fac;
    } else {
      worldContainer.x = 0; worldContainer.y = 0;
      shakeIntensity = 0;
    }
  }

  processMoveInput();
  updateParticles();
  if (gameState) {
    renderGame(gameState);
    renderIndicators();
  }
});

// ── Room List ─────────────────────────────────────────────────────────────────
async function fetchAndRenderRooms() {
  const listEl  = document.getElementById('rooms-list');
  const countEl = document.getElementById('rooms-count');
  if (!listEl) return;

  if (countEl) countEl.textContent = '불러오는 중…';
  listEl.innerHTML = '<div class="rooms-empty">로딩 중…</div>';

  try {
    const res  = await fetch('/api/rooms');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    // Only show lobby-phase rooms (not in-game)
    const openRooms = (data.rooms ?? []).filter(r => r.phase === 'lobby');

    if (openRooms.length === 0) {
      listEl.innerHTML = '<div class="rooms-empty">현재 참여 가능한 방이 없습니다</div>';
      if (countEl) countEl.textContent = '방 0개';
    } else {
      listEl.innerHTML = openRooms.map(r => `
        <div class="room-card">
          <div>
            <div class="room-card-code">${r.code}</div>
            <div class="room-card-meta">🎮 ${r.playerCount} / ${r.maxPlayers}명 대기 중</div>
          </div>
          <button class="room-join-btn" data-code="${r.code}">입장</button>
        </div>
      `).join('');
      if (countEl) countEl.textContent = `방 ${openRooms.length}개`;

      listEl.querySelectorAll('.room-join-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          sendWS({ type: 'join_room', roomCode: btn.dataset.code });
        });
      });
    }
  } catch (err) {
    listEl.innerHTML = '<div class="rooms-empty">방 목록을 불러올 수 없습니다</div>';
    if (countEl) countEl.textContent = '오류';
    console.warn('[rooms] fetch failed:', err.message);
  }
}

document.getElementById('btn-rooms-show').addEventListener('click', () => {
  setLobbyPanel('lobby-rooms');
  fetchAndRenderRooms();
});

document.getElementById('btn-rooms-back').addEventListener('click', () => {
  setLobbyPanel('lobby-init');
});

document.getElementById('btn-rooms-refresh').addEventListener('click', () => {
  fetchAndRenderRooms();
});

// ── Restart (no page reload) ──────────────────────────────────────────────────
document.getElementById('btn-restart-game')?.addEventListener('click', () => {
  sessionKills = 0; sessionCurrentCombo = 0; sessionMaxCombo = 0; sessionLastKillTime = 0;
  dyingEnemies.clear();
  isPaused = false;
  document.getElementById('pause-overlay')?.classList.remove('visible');
  sendWS({ type: 'restart_game' });
});

// ── ESC Pause / Resume ────────────────────────────────────────────────────────
document.addEventListener('keydown', evt => {
  if (evt.key !== 'Escape') return;
  const hudEl = document.getElementById('game-hud');
  if (!hudEl || hudEl.classList.contains('hidden')) return;
  isPaused = !isPaused;
  document.getElementById('pause-overlay')?.classList.toggle('visible', isPaused);
});

// ── AudioContext: init on first user interaction ──────────────────────────────
document.addEventListener('pointerdown', () => { _getAC(); }, { once: true });

// ── Boot ──────────────────────────────────────────────────────────────────────
showScreen('lobby-screen');
setLobbyPanel('lobby-init');
connect();

// ── Test helper ───────────────────────────────────────────────────────────────
window.__sendWS = sendWS;

})();
