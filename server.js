'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');
const WebSocket = require('ws');

// ─── Config (hot-reload) ──────────────────────────────────────────────────────
const BALANCE_PATH = path.join(__dirname, 'config', 'balance.json');
let B = loadBalance();
function loadBalance() {
  try { return JSON.parse(fs.readFileSync(BALANCE_PATH, 'utf8')); }
  catch (e) { console.error('[config] load failed:', e.message); return B; }
}
fs.watch(BALANCE_PATH, () => { B = loadBalance(); console.log('[config] balance.json reloaded'); });

// ─── ML Service Config ────────────────────────────────────────────────────────
// ML_SERVICE_URL: FastAPI 추론 서비스 엔드포인트 (기본 127.0.0.1:8001)
// ML_HTTP_TIMEOUT: 단일 추론 요청 타임아웃(ms) — 이 값 초과 시 자동 폴백
const ML_SERVICE_URL  = process.env.ML_SERVICE_URL  || 'http://127.0.0.1:8001';
const ML_HTTP_TIMEOUT = parseInt(process.env.ML_HTTP_TIMEOUT || '80', 10);

// ─── Utilities ────────────────────────────────────────────────────────────────
let _id = 0;
const genId = (pfx = '') => `${pfx}${++_id}`;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dist2  = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
const avg    = arr => arr.reduce((s, v) => s + v, 0) / (arr.length || 1);
const rng    = max => Math.floor(Math.random() * max);

// ─── Combat Constants ─────────────────────────────────────────────────────────
// 수치는 balance.json으로 외부화 → 핫리로드 반영
// comboWindowMs / comboDamageMult / coComboSurge / shieldDefense* 모두 B(balance) 참조

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[rng(chars.length)]).join('');
  } while (roomsByCode.has(code));
  return code;
}

// ─── MIME ─────────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

// ─── Shape Recognition ────────────────────────────────────────────────────────

/** Count sharp direction-change corners using a sliding window.
 *  Wraps first step*2 points so closing corners of closed paths are detected. */
function countSharpCorners(points, threshDeg, step = 5) {
  const threshRad = threshDeg * Math.PI / 180;
  const pts = [...points, ...points.slice(0, step * 2)];
  let count = 0, lastIdx = -999;
  for (let i = step; i < pts.length - step; i++) {
    const dx1 = pts[i].x - pts[i - step].x;
    const dy1 = pts[i].y - pts[i - step].y;
    const dx2 = pts[i + step].x - pts[i].x;
    const dy2 = pts[i + step].y - pts[i].y;
    const len1 = Math.hypot(dx1, dy1) || 1;
    const len2 = Math.hypot(dx2, dy2) || 1;
    const dot  = (dx1 * dx2 + dy1 * dy2) / (len1 * len2);
    const angle = Math.acos(clamp(dot, -1, 1));
    if (angle >= threshRad && i - lastIdx >= step * 2) {
      count++;
      lastIdx = i;
    }
  }
  return count;
}

/** Path is closed if first/last points are within 38% of bounding-box diagonal. */
function isPathClosed(points) {
  if (points.length < 8) return false;
  const first = points[0], last = points[points.length - 1];
  const d = dist2(first.x, first.y, last.x, last.y);
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const diag = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  return d < diag * 0.38;
}

/** Count local peaks in the radial distance from centroid. */
function countRadialPeaks(points) {
  const cx = avg(points.map(p => p.x));
  const cy = avg(points.map(p => p.y));
  const raw = points.map(p => dist2(p.x, p.y, cx, cy));
  const sm  = raw.map((d, i) => {
    const l = raw[Math.max(0, i - 2)], r = raw[Math.min(raw.length - 1, i + 2)];
    return (l + d + r) / 3;
  });
  let peaks = 0;
  for (let i = 1; i < sm.length - 1; i++) {
    if (sm[i] > sm[i - 1] && sm[i] > sm[i + 1]) peaks++;
  }
  return peaks;
}

/** Count direction reversals in both X and Y axes; return the maximum. */
function countDirectionReversals(points) {
  let revX = 0, lastDirX = 0;
  let revY = 0, lastDirY = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    if (Math.abs(dx) >= 2) {
      const d = dx > 0 ? 1 : -1;
      if (lastDirX !== 0 && d !== lastDirX) revX++;
      lastDirX = d;
    }
    const dy = points[i].y - points[i - 1].y;
    if (Math.abs(dy) >= 2) {
      const d = dy > 0 ? 1 : -1;
      if (lastDirY !== 0 && d !== lastDirY) revY++;
      lastDirY = d;
    }
  }
  return Math.max(revX, revY);
}

/**
 * recognizeShape — returns { shape, confidence: 0~1 }
 * Polygon/star checked BEFORE circle to avoid over-matching.
 */
function recognizeShape(points) {
  const cfg = B.drawing;
  if (!points || points.length < cfg.minPoints) return { shape: null, confidence: 0 };
  for (const p of points) { if (!isFinite(p.x) || !isFinite(p.y)) return { shape: null, confidence: 0 }; }

  const closed    = isPathClosed(points);
  const corners65 = countSharpCorners(points, cfg.triangleAngleThresh || 65);
  const peaks     = countRadialPeaks(points);
  const reversals = countDirectionReversals(points);
  const starMin   = cfg.starMinPeaks     || 4;
  const zigMin    = cfg.zigzagMinReversal || 4;

  // 1. Star: many radial peaks + closed
  if (peaks >= starMin && closed) {
    const conf = clamp(0.50 + (peaks - starMin + 1) * 0.10, 0.60, 1.00);
    return { shape: 'star', confidence: parseFloat(conf.toFixed(3)) };
  }

  // 2. Closed polygon
  if (closed) {
    if (corners65 >= 2 && corners65 <= 3) {
      return { shape: 'triangle', confidence: corners65 === 3 ? 0.88 : 0.68 };
    }
    if (corners65 >= 4) {
      const conf = parseFloat(clamp(0.85 - (corners65 - 4) * 0.06, 0.60, 0.85).toFixed(3));
      return { shape: 'square', confidence: conf };
    }
    const c55 = countSharpCorners(points, 55);
    if (c55 >= 2 && c55 <= 3) return { shape: 'triangle', confidence: 0.62 };
    if (c55 >= 4)              return { shape: 'square',   confidence: 0.62 };
    if (peaks >= 3)            return { shape: 'star',     confidence: 0.60 };
  }

  // 3. Zigzag: many direction reversals
  if (reversals >= zigMin) {
    const conf = parseFloat(clamp(0.45 + (reversals - zigMin + 1) * 0.10, 0.55, 1.00).toFixed(3));
    return { shape: 'zigzag', confidence: conf };
  }

  // 4. Circle: rounded path (checked AFTER polygons)
  {
    const cx = avg(points.map(p => p.x));
    const cy = avg(points.map(p => p.y));
    const dists  = points.map(p => dist2(p.x, p.y, cx, cy));
    const meanR  = avg(dists);
    if (meanR >= cfg.minRadius) {
      const variance = avg(dists.map(d => (d - meanR) ** 2));
      const cv = Math.sqrt(variance) / meanR;
      const angles = points.map(p => Math.atan2(p.y - cy, p.x - cx));
      let totalSweep = 0;
      for (let i = 1; i < angles.length; i++) {
        let da = angles[i] - angles[i - 1];
        while (da >  Math.PI) da -= 2 * Math.PI;
        while (da < -Math.PI) da += 2 * Math.PI;
        totalSweep += Math.abs(da);
      }
      if (cv <= cfg.maxCoefficientOfVariation && totalSweep >= cfg.minAngularSweep) {
        const cvConf    = clamp(1 - cv / cfg.maxCoefficientOfVariation, 0, 1);
        const sweepConf = clamp(totalSweep / (2 * Math.PI), 0, 1);
        const conf = parseFloat(clamp(cvConf * 0.55 + sweepConf * 0.45, 0.45, 1.00).toFixed(3));
        return { shape: 'circle', confidence: conf };
      }
    }
  }

  // 5. Generous fallbacks
  if (corners65 >= 2 && corners65 <= 3) return { shape: 'triangle', confidence: 0.50 };
  if (corners65 >= 4)                   return { shape: 'square',   confidence: 0.50 };
  if (reversals >= 2)                   return { shape: 'zigzag',   confidence: 0.42 };

  return { shape: null, confidence: 0 };
}

// ─── ML Service Call ──────────────────────────────────────────────────────────
/**
 * mlServiceCall — FastAPI /infer 엔드포인트를 호출하고 { shape, confidence } 반환.
 * ML_HTTP_TIMEOUT 초과 또는 5xx/연결 오류 시 throw — 호출자가 폴백 처리.
 * 신뢰도 필드: data.confidence == null/undefined → NaN (Number() 캐스팅 금지).
 */
async function mlServiceCall(pts) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ML_HTTP_TIMEOUT);
  try {
    const res = await fetch(`${ML_SERVICE_URL}/infer`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ points: pts }),
      signal:  ctrl.signal,
    });
    if (!res.ok) throw new Error(`ml_service HTTP ${res.status}`);
    const data = await res.json();
    return {
      shape:      data.shape      ?? null,
      // confidence: null/undefined → NaN (Number(null)===0 silent bug 차단)
      confidence: (data.confidence != null && typeof data.confidence === 'number')
                    ? data.confidence
                    : NaN,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Maps 0~1 confidence to a tier from balance.json drawing.confidenceTiers */
function getConfidenceTier(confidence) {
  const tiers = B.drawing.confidenceTiers;
  if (!tiers || !tiers.length) return { min: 0, max: 1.01, damageMult: 1.0, label: '정상' };
  for (const tier of tiers) {
    if (confidence >= tier.min && confidence < tier.max) return tier;
  }
  return tiers[tiers.length - 1];
}

// ─── ML Circuit Breaker ────────────────────────────────────────────────────────
// Config: config/balance.json → drawing.circuitBreaker
// Defaults: maxErrors=5, windowMs=5000, latencyMs=100, resetMs=30000
const mlCB = {
  errorTimestamps: [],   // epoch-ms of recent ML errors within windowMs
  trippedAt:       null, // epoch-ms when CB tripped; null = closed
};

function cbRecordError() {
  const now    = Date.now();
  const cfg    = (B.drawing && B.drawing.circuitBreaker) || {};
  const winMs  = cfg.windowMs  ?? 5000;
  const maxErr = cfg.maxErrors ?? 5;
  // Purge expired timestamps
  mlCB.errorTimestamps = mlCB.errorTimestamps.filter(t => now - t < winMs);
  mlCB.errorTimestamps.push(now);
  if (!mlCB.trippedAt && mlCB.errorTimestamps.length >= maxErr) {
    mlCB.trippedAt = now;
    console.warn(`[CB] TRIPPED — ${mlCB.errorTimestamps.length} errors in ${winMs}ms`);
  }
}

function cbIsTripped() {
  if (!mlCB.trippedAt) return false;
  const cfg     = (B.drawing && B.drawing.circuitBreaker) || {};
  const resetMs = cfg.resetMs ?? 30000;
  if (Date.now() - mlCB.trippedAt >= resetMs) {
    mlCB.trippedAt       = null;
    mlCB.errorTimestamps = [];
    console.log('[CB] RESET (half-open)');
    return false;
  }
  return true;
}

// ─── ML Output Schema Validation ─────────────────────────────────────────────
/**
 * Validate ML output fields.
 * confidence: must be a finite number — undefined/null/string → NaN.
 * (Number(null)===0 silent bug blocked: we only accept typeof===number && isFinite.)
 */
function validateMlOutput(raw) {
  let { shape = null, confidence } = raw || {};
  if (typeof shape !== 'string') shape = null;
  // NEVER use Number() cast: Number(null)===0 would silently pass null as 0
  if (typeof confidence !== 'number' || !isFinite(confidence)) {
    confidence = NaN;
  }
  return { shape, confidence };
}

// ─── ML Inference Wrapper ─────────────────────────────────────────────────────
/**
 * mlInfer — FastAPI(mlServiceCall) 우선, 실패 시 로컬 heuristic(recognizeShape) 폴백.
 *   1. CB tripped → 즉시 로컬 heuristic (FastAPI 스킵)
 *   2. FastAPI 성공 + latency OK + schema valid → { shape, confidence, fallback: false }
 *   3. FastAPI 실패(타임아웃·5xx·연결 끊김) → cbRecordError + 로컬 heuristic, fallback: true
 *   4. Latency SLA 초과 → cbRecordError + 로컬 heuristic, fallback: true
 *   5. Schema 검증 실패 → cbRecordError + 로컬 heuristic, fallback: true
 * 반환: { shape, confidence, fallback: boolean }.
 * fallback:true → UI "추정값 사용 중" 표시, 게임 루프는 중단 없음.
 */
async function mlInfer(pts) {
  const cfg        = (B.drawing && B.drawing.circuitBreaker) || {};
  const latencySla = cfg.latencyMs ?? 100;

  // 로컬 heuristic 폴백 헬퍼: recognizeShape 실행 후 schema 검증
  function runLocalFallback(reason) {
    console.warn(`[ml] ${reason} — local heuristic fallback`);
    try {
      const r = recognizeShape(pts);
      return { ...validateMlOutput(r), fallback: true };
    } catch (hErr) {
      console.error('[ml] heuristic error:', hErr.message);
      return { shape: null, confidence: NaN, fallback: true };
    }
  }

  // 1. CB tripped → 로컬 heuristic 즉시 실행
  if (cbIsTripped()) {
    return runLocalFallback('CB tripped');
  }

  // 2. FastAPI 호출 (ML_HTTP_TIMEOUT ms 이내)
  const t0 = Date.now();
  let raw;
  try {
    raw = await mlServiceCall(pts);
  } catch (err) {
    cbRecordError();
    return runLocalFallback(`FastAPI error: ${err.message}`);
  }

  // 3. Latency SLA
  const elapsed = Date.now() - t0;
  if (elapsed > latencySla) {
    console.warn(`[ml] latency SLA breached: ${elapsed}ms > ${latencySla}ms`);
    cbRecordError();
    return runLocalFallback('latency SLA breached');
  }

  // 4. Schema validation (confidence not finite → fallback)
  const validated = validateMlOutput(raw);
  if (isNaN(validated.confidence)) {
    console.warn('[ml] schema validation failed: confidence was', raw && raw.confidence);
    cbRecordError();
    return runLocalFallback('schema validation failed');
  }

  return { ...validated, fallback: false };
}

// ─── Elemental Damage ─────────────────────────────────────────────────────────
function calcDamage(base, atkElem, defElem) {
  if (!atkElem || !defElem) return Math.round(base);
  const mult = (B.elementAffinity[atkElem] || {})[defElem] ?? 1.0;
  return Math.round(base * mult);
}

// ─── Player Factory ───────────────────────────────────────────────────────────
// Up to 4 players: corners + top/bottom-center
const PLAYER_START_POSITIONS = [
  { x: 200,  y: null },   // left-center  (y filled from arenaHeight)
  { x: null, y: null },   // right-center
  { x: null, y: 200  },   // top-center
  { x: null, y: null },   // bottom-center
];

function createPlayer(id, index, nickname) {
  const p   = B.player;
  const AW  = B.game.arenaWidth;
  const AH  = B.game.arenaHeight;
  const positions = [
    { x: 200,      y: AH / 2      },
    { x: AW - 200, y: AH / 2      },
    { x: AW / 2,   y: 200         },
    { x: AW / 2,   y: AH - 200    },
  ];
  const pos = positions[index] || positions[0];
  return {
    id, index,
    nickname:         nickname || `Player${index + 1}`,
    element:          null,
    elements:         [],
    passives:         [],
    unlockedShapes:   [...(p.initialShapes || ['circle', 'triangle', 'star'])],
    hp:               p.baseHp,
    maxHp:            p.baseHp,
    mana:             p.baseMana,
    maxMana:          p.baseMana,
    x:    pos.x,
    y:    pos.y,
    targetX: pos.x,
    targetY: pos.y,
    level:            1,
    exp:              0,
    expToNext:        p.expToLevelBase,
    alive:            true,
    drawing:          false,
    drawPoints:       [],
    spellCooldown:    0,
    invincible:       0,
    connected:        true,
    disconnectTimer:  0,
    damageMultiplier:    1.0,
    cooldownMultiplier:  1.0,
    manaRegenMultiplier: 1.0,
    dualCast:        false,
    novaBonusCount:  0,
    chainBonus:      0,
    pierceBonus:     0,
    pulseRangeBonus: 0,
    pendingShape:    null,
    pendingAugments: [],
    levelUpQueue:    [],   // queued during 'playing', drained after wave_clear
  };
}

// ─── Enemy Factory ────────────────────────────────────────────────────────────
function spawnEnemy(type, waveNum, overrideElement, hpScale = 1.0) {
  const cfg   = B.enemies[type] || B.enemies.basic;
  const wCfg  = B.wave;
  const baseHp  = wCfg.baseEnemyHp   * (wCfg.hpGrowthPerWave    ** (waveNum - 1));
  const baseDmg = wCfg.baseDamage    * (wCfg.damageGrowthPerWave ** (waveNum - 1));
  const baseSp  = wCfg.baseSpeed     * (wCfg.speedGrowthPerWave  ** (waveNum - 1));

  const AW = B.game.arenaWidth, AH = B.game.arenaHeight;
  const edge = rng(4);
  let sx, sy;
  if      (edge === 0) { sx = Math.random() * AW; sy = -60; }
  else if (edge === 1) { sx = AW + 60;             sy = Math.random() * AH; }
  else if (edge === 2) { sx = Math.random() * AW; sy = AH + 60; }
  else                 { sx = -60;                 sy = Math.random() * AH; }

  const elem = overrideElement || cfg.element;
  const hp   = Math.round(baseHp * cfg.hpMult * hpScale);
  return {
    id:             genId('e'),
    type,
    label:          cfg.label,
    element:        elem,
    hp,
    maxHp:          hp,
    x:              sx,
    y:              sy,
    speed:          baseSp * cfg.speedMult,
    damage:         Math.round(baseDmg * cfg.damageMult),
    attackRange:    cfg.attackRange,
    attackCooldown: cfg.attackCooldownTicks,
    attackTimer:    0,
    radius:         cfg.radius,
    exp:            Math.round(wCfg.expPerEnemy * cfg.expMult),
    score:          cfg.score,
    alive:          true,
    targetId:       null,
    melee:          cfg.melee !== false && type !== 'ranged' && type !== 'healer',
    projectileSpeed: cfg.projectileSpeed || null,
    healRadius:     cfg.healRadius  || 0,
    healAmount:     cfg.healAmount  || 0,
    healTimer:      0,
    windupSent:     false,  // attack_anim windup broadcast guard
    // ── 방패 전용 상태 (shield type) ──────────────────────────────────────
    shieldDefenseTimer: 0,  // >0 이면 방어 패턴 중; 매 틱 감소
    shieldAttackCount:  0,  // 공격 횟수 누적; trigger 도달 시 방어 진입
  };
}

// ─── Wave Composition ─────────────────────────────────────────────────────────
function buildSpawnQueue(waveNum) {
  const isBoss = waveNum % B.game.bossWaveInterval === 0;
  let templateKey;
  if (isBoss) {
    templateKey = waveNum <= 5 ? '5' : '10';
  } else {
    const nonBossKeys = ['1','2','3','4','6','7','8','9'];
    templateKey = nonBossKeys[(waveNum - 1) % nonBossKeys.length];
  }
  const template = B.waveComposition[templateKey] || B.waveComposition['4'];
  const extra = Math.max(0, waveNum - 10);
  let types = [...template];
  for (let i = 0; i < Math.floor(extra / 2); i++) types.push('basic', 'fast');

  // wave 11+: 힐러·방패·원거리 특수 적 최소 1마리 보장 (QA 재현 가능)
  if (waveNum > 10 && !isBoss) {
    if (!types.includes('healer')) types.push('healer');
    if (!types.includes('shield')) types.push('shield');
    if (!types.includes('ranged')) types.push('ranged');
    console.log(`[wave] ${waveNum} special enemies guaranteed: +${
      ['healer','shield','ranged'].filter(t => !template.includes(t)).join('+') || 'already present'
    }`);
  }

  if (isBoss) {
    const bossElem = B.bossElements[(Math.floor(waveNum / B.game.bossWaveInterval) - 1) % B.bossElements.length];
    return types.map(t => ({ type: t, element: t === 'boss' ? bossElem : null }));
  }
  return types.map(t => ({ type: t, element: null }));
}

// ─── Room Factory ─────────────────────────────────────────────────────────────
function createRoomObj(code) {
  return {
    id:           genId('r'),
    code,
    hostPlayerId: null,
    players:      {},
    wsMap:        {},
    phase:        'lobby',
    tick:         0,
    wave: {
      number:     0,
      enemies:    [],
      spells:     [],
      projList:   [],
      spawnQueue: [],
      spawnTimer: 0,
      clearTimer: 0,
      prepTimer:  0,
      lastHitMap: new Map(),  // combo tracker: enemyId → { attackerId, timestamp }
    },
    advisor:      null,
    advisorTimer: 0,
    score:        0,
    loopInterval: null,
    cleanupTimer: null,   // setTimeout handle for room deletion (cancelled on restart)
    metrics: {
      // ── Per-wave (매 wave_start마다 리셋) ──────────────────────────────────
      waveStartHp:      {},   // { pid: hp } — 파동 시작 시 HP 스냅샷
      damageTaken:      0,    // 이번 파동에서 플레이어가 받은 총 피해 (DDA 지표)
      spellsAttempted:  0,    // 이번 파동에서 성공 시전된 주문 수
      spellsHit:        0,    // 이번 파동에서 적에게 명중된 히트 수 (보조 지표)
      // ── 누적 세션 데이터 ──────────────────────────────────────────────────
      ddaScale:         1.0,  // DDA 배율 (0.8~1.2, 1.0=기준)
      elementUseCount:  {},   // { pid: { fire:N, water:M, ... } } — 누적 (리셋 없음)
      lastSpellCast:    {},   // { pid: { element, time, x, y } } — 시너지 감지용
      synergyCooldown:  0,    // epoch-ms: 다음 시너지 허용 시간
      // ── 킬 추적 (리더보드용) ──────────────────────────────────────────────
      totalKills:       0,
      maxWave:          0,
      currentKillCombo: 0,
      lastKillTime:     0,
      maxKillCombo:     0,
    },
  };
}

// ─── Room Registry ────────────────────────────────────────────────────────────
const rooms        = new Map(); // roomId → room
const roomsByCode  = new Map(); // code   → room
const pendingConns = new Map(); // ws     → { playerId }

// ─── Session Leaderboard (파일 기반 영속, 최대 10개) ────────────────────────────
const LEADERBOARD_PATH = path.join(__dirname, 'leaderboard.json');
const LEADERBOARD_MAX  = 10;
let   leaderboard      = [];
(function loadLeaderboardFile() {
  try {
    const raw    = fs.readFileSync(LEADERBOARD_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) leaderboard = parsed;
    console.log(`[leaderboard] loaded ${leaderboard.length} entries from ${LEADERBOARD_PATH}`);
  } catch (e) {
    leaderboard = [];
    if (e.code !== 'ENOENT') console.warn('[leaderboard] parse error:', e.message);
    else console.log('[leaderboard] no existing file — starting fresh');
  }
})();

// ─── Leaderboard File I/O ─────────────────────────────────────────────────────
function writeLeaderboardFile() {
  const tmp = LEADERBOARD_PATH + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(leaderboard, null, 2), 'utf8');
    fs.renameSync(tmp, LEADERBOARD_PATH);
  } catch (e) {
    console.error('[leaderboard] file write failed:', e.message);
  }
}

// ─── Broadcast helpers ────────────────────────────────────────────────────────
// [이벤트 라우팅 기준 — routing-spec.md 참조]
// broadcast : 공유 상태 — 모든 클라이언트가 동일하게 보여야 하는 정보
//   (state, wave_start/clear/prep, enemy_spawn/die/heal, hit, co_combo_hit,
//    spell_cast, attack_anim, boss_spawn, player_die/revive/disconnect,
//    level_up, augment_selected, shape_unlocked, shape_recognized,
//    countdown, game_over, advisor, shield_defense)
// sendTo    : 경쟁 정보 — 해당 플레이어에게만 전달 (상대방이 알면 전략적 불이익)
//   (spell_result, augment_options, level_up_queued,
//    room_created, room_joined, room_error, connected, reconnected, error)
function broadcast(room, msg) {
  const raw = JSON.stringify(msg);
  for (const ws of Object.values(room.wsMap)) {
    if (ws && ws.readyState === WebSocket.OPEN) try { ws.send(raw); } catch (_) {}
  }
}

function sendTo(room, pid, msg) {
  const ws = room.wsMap[pid];
  if (ws && ws.readyState === WebSocket.OPEN) try { ws.send(JSON.stringify(msg)); } catch (_) {}
}

function sendWs(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) try { ws.send(JSON.stringify(msg)); } catch (_) {}
}

// ─── State Serialization ──────────────────────────────────────────────────────
function serialize(room) {
  const w = room.wave;
  return {
    type:     'state',
    tick:     room.tick,
    phase:    room.phase,
    score:    room.score,
    roomCode: room.code,
    wave: {
      number:     w.number,
      enemyTotal: w.spawnQueue.length + w.enemies.filter(e => e.alive).length,
      enemyAlive: w.enemies.filter(e => e.alive).length,
      hasBoss:    w.enemies.some(e => e.type === 'boss' && e.alive),
      prepTimer:  w.prepTimer,
    },
    players: Object.fromEntries(
      Object.entries(room.players).map(([pid, p]) => [pid, {
        id: p.id, index: p.index, isHost: p.id === room.hostPlayerId,
        nickname: p.nickname || `Player${p.index + 1}`,
        element: p.element, elements: p.elements, passives: p.passives,
        unlockedShapes: p.unlockedShapes || [],
        hp: p.hp, maxHp: p.maxHp, mana: p.mana, maxMana: p.maxMana,
        x: p.x, y: p.y, level: p.level, exp: p.exp, expToNext: p.expToNext,
        alive: p.alive, drawing: p.drawing, connected: p.connected,
        spellCooldown: p.spellCooldown,
        damageMultiplier: p.damageMultiplier,
        cooldownMultiplier: p.cooldownMultiplier,
        dualCast: p.dualCast, novaBonusCount: p.novaBonusCount,
        chainBonus: p.chainBonus, pierceBonus: p.pierceBonus,
        pulseRangeBonus: p.pulseRangeBonus,
        hasPendingAugments: p.pendingAugments.length > 0,
        pendingQueueCount:  p.levelUpQueue.length,
      }])
    ),
    enemies: w.enemies.filter(e => e.alive).map(e => ({
      id: e.id, type: e.type, element: e.element, label: e.label,
      hp: e.hp, maxHp: e.maxHp, x: e.x, y: e.y, radius: e.radius,
    })),
    spells: w.spells.map(s => ({
      id: s.id, ownerId: s.ownerId, element: s.element,
      spellType: s.spellType, shape: s.shape,
      x: s.x, y: s.y, radius: s.radius,
    })),
    projList: w.projList.map(pr => ({
      id: pr.id, element: pr.element, x: pr.x, y: pr.y, radius: pr.radius,
    })),
    advisor: room.advisor,
  };
}

// ─── Augment Queue Helpers ────────────────────────────────────────────────────

/** Returns true if any player has unresolved augments (queue or pending). */
function hasAnyPendingAugments(room) {
  return Object.values(room.players).some(
    p => p.pendingAugments.length > 0 || p.levelUpQueue.length > 0
  );
}

/**
 * Drain one queued level-up per player who has empty pendingAugments.
 * Called after wave_clear and after each select_augment.
 */
function drainAugmentQueue(room) {
  for (const player of Object.values(room.players)) {
    if (player.pendingAugments.length > 0) continue;  // already showing options
    if (player.levelUpQueue.length === 0) continue;   // nothing queued
    const next = player.levelUpQueue.shift();
    player.pendingAugments = next.options;
    sendTo(room, player.id, {
      type:    'augment_options',
      playerId: player.id,
      level:    next.level,
      queued:   player.levelUpQueue.length,  // remaining after this
      options:  next.options.map((o, i) => ({
        index: i, kind: o.kind, id: o.id,
        label: o.label, desc: o.desc,
        unlocksShape: o.unlocksShape || null,
      })),
    });
  }
}

// ─── Augment System ───────────────────────────────────────────────────────────
function generateAugmentOptions(player) {
  const pool = B.augmentPool;
  const options = [];
  const usedIds = new Set();

  // Locked shapes eligible for unlock (square, zigzag)
  const lockedShapes = Object.entries(pool.shapes || {})
    .filter(([sh]) => !(player.unlockedShapes || []).includes(sh));

  // Slot 1: unlearned element > locked shape > stat
  const unlearnedEls = Object.keys(pool.elements).filter(el => !player.elements.includes(el));
  if (unlearnedEls.length > 0) {
    const el = unlearnedEls[rng(unlearnedEls.length)];
    options.push({ kind: 'element', id: el, ...pool.elements[el] });
    usedIds.add('el_' + el);
  } else if (lockedShapes.length > 0) {
    const [sh, shDef] = lockedShapes[rng(lockedShapes.length)];
    options.push({ kind: 'shape', id: sh, ...shDef });
    usedIds.add('sh_' + sh);
  } else {
    const stat = pool.stats[rng(pool.stats.length)];
    options.push({ kind: 'stat', ...stat });
    usedIds.add(stat.id);
  }

  // Slot 2: remaining locked shape OR random stat
  const remainingLocked = lockedShapes.filter(([sh]) => !usedIds.has('sh_' + sh));
  if (remainingLocked.length > 0 && options[0].kind !== 'shape') {
    const [sh, shDef] = remainingLocked[rng(remainingLocked.length)];
    options.push({ kind: 'shape', id: sh, ...shDef });
    usedIds.add('sh_' + sh);
  } else {
    const avail2 = pool.stats.filter(s => !usedIds.has(s.id));
    const stat2  = avail2.length > 0 ? avail2[rng(avail2.length)] : pool.stats[rng(pool.stats.length)];
    options.push({ kind: 'stat', ...stat2 });
    usedIds.add(stat2.id);
  }

  // Slot 3: passive meeting minLevel, or fallback stat
  const availPassives = pool.passives.filter(
    p => player.level >= (p.minLevel || 1) && !player.passives.includes(p.id)
  );
  if (availPassives.length > 0) {
    options.push({ kind: 'passive', ...availPassives[rng(availPassives.length)] });
  } else {
    const avail3 = pool.stats.filter(s => !usedIds.has(s.id));
    const stat3  = avail3.length > 0 ? avail3[rng(avail3.length)] : pool.stats[0];
    options.push({ kind: 'stat', ...stat3 });
  }

  return options;
}

function applyAugment(player, option) {
  if (!option) return;
  if (option.kind === 'element' && !player.elements.includes(option.id)) {
    player.elements.push(option.id);
    if (!player.element) player.element = option.id;
  }
  if (option.kind === 'shape' && option.unlocksShape) {
    if (!player.unlockedShapes.includes(option.unlocksShape)) {
      player.unlockedShapes.push(option.unlocksShape);
    }
  }
  if (option.kind === 'passive' && !player.passives.includes(option.id)) {
    player.passives.push(option.id);
  }
  if (option.damageMultiplier)    player.damageMultiplier    *= option.damageMultiplier;
  if (option.cooldownMultiplier)  player.cooldownMultiplier  *= option.cooldownMultiplier;
  if (option.manaRegenMultiplier) player.manaRegenMultiplier *= option.manaRegenMultiplier;
  if (option.maxHpBonus) {
    player.maxHp += option.maxHpBonus;
    player.hp     = Math.min(player.hp + option.maxHpBonus, player.maxHp);
  }
  if (option.allMultiplier) {
    player.damageMultiplier    *= option.allMultiplier;
    player.cooldownMultiplier  *= option.allMultiplier;
    player.manaRegenMultiplier *= option.allMultiplier;
  }
  if (option.dualCast)        player.dualCast         = true;
  if (option.novaBonusCount)  player.novaBonusCount  += option.novaBonusCount;
  if (option.chainBonus)      player.chainBonus      += option.chainBonus;
  if (option.pierceBonus)     player.pierceBonus     += option.pierceBonus;
  if (option.pulseRangeBonus) player.pulseRangeBonus += option.pulseRangeBonus;
}

// ─── Level Up ─────────────────────────────────────────────────────────────────
function applyLevelUp(room, player) {
  player.level++;
  player.exp = 0;
  player.expToNext = Math.round(
    B.player.expToLevelBase * (B.player.expToLevelMultiplier ** (player.level - 1))
  );

  const options = generateAugmentOptions(player);

  // Always broadcast the level-up event so everyone sees it
  broadcast(room, { type: 'level_up', playerId: player.id, level: player.level });

  if (room.phase === 'playing') {
    // Queue augment display for after wave_clear
    player.levelUpQueue.push({ level: player.level, options });
    sendTo(room, player.id, {
      type: 'level_up_queued',
      playerId: player.id, level: player.level,
      queuedCount: player.levelUpQueue.length,
    });
  } else {
    // During wave_clear / wave_prep / lobby: show immediately
    player.pendingAugments = options;
    sendTo(room, player.id, {
      type:    'augment_options',
      playerId: player.id,
      level:    player.level,
      queued:   0,
      options:  options.map((o, i) => ({
        index: i, kind: o.kind, id: o.id,
        label: o.label, desc: o.desc,
        unlocksShape: o.unlocksShape || null,
      })),
    });
  }
}

function awardExp(room, amount) {
  for (const p of Object.values(room.players)) {
    if (!p.alive) continue;
    p.exp += amount;
    while (p.exp >= p.expToNext) applyLevelUp(room, p);
  }
}

// ─── Kill Enemy ───────────────────────────────────────────────────────────────
function killEnemy(room, e) {
  if (!e.alive) return;
  e.alive = false;
  room.score += e.score;
  awardExp(room, e.exp);

  // ── 킬 콤보 + 총 킬 추적 (리더보드·DDA용) ─────────────────────────────────
  if (room.metrics) {
    const now           = Date.now();
    const comboWindowMs = B.game.comboWindowMs ?? 1500;
    const m             = room.metrics;
    if (now - m.lastKillTime <= comboWindowMs) {
      m.currentKillCombo++;
    } else {
      m.currentKillCombo = 1;
    }
    m.lastKillTime = now;
    m.maxKillCombo = Math.max(m.maxKillCombo, m.currentKillCombo);
    m.totalKills++;
  }

  broadcast(room, { type: 'enemy_die', enemyId: e.id, element: e.element, score: e.score });
}

// ─── Kill Player ──────────────────────────────────────────────────────────────
function killPlayer(room, p) {
  if (!p.alive) return;
  p.alive = false; p.hp = 0;
  broadcast(room, { type: 'player_die', playerId: p.id });
  const anyAlive = Object.values(room.players).some(pl => pl.alive);
  if (!anyAlive) {
    room.phase = 'game_over';
    broadcast(room, { type: 'game_over', wave: room.wave.number, score: room.score });
    // 리더보드 저장 + 브로드캐스트 (game_over 이후 순서 — 클라이언트가 화면 전환 후 수신)
    if (room.metrics) room.metrics.maxWave = Math.max(room.metrics.maxWave, room.wave.number);
    saveLeaderboard(room);
    clearInterval(room.loopInterval);
    room.cleanupTimer = setTimeout(() => {
      rooms.delete(room.id);
      roomsByCode.delete(room.code);
    }, 60_000);
  }
}

// ─── Enemy Hit Processing (damage + co_combo + elemental_surge + shield) ──────
/**
 * processEnemyHit — 플레이어 스펠이 적에게 가하는 히트를 중앙화.
 *
 * [이벤트 라우팅]
 *   hit         → broadcast (공유 상태: 피해 판정·이펙트)
 *   co_combo_hit → broadcast (공유 상태: 협동 콤보 + elemental_surge)
 *
 * [처리 순서]
 *   1) 협동 콤보 감지 (comboWindowMs 이내 다른 attackerId)
 *   2) elemental_surge: 속성 조합 → coComboSurge 테이블 배율 추가
 *   3) 방패 방어 감소: shieldDefenseTimer>0이면 피해 (1-shieldDamageReduction) 적용
 *   4) hit broadcast (모든 히트), co_combo_hit broadcast (콤보일 때만)
 *   5) 적 사망 → killEnemy
 *
 * Returns: 실제 적용된 데미지
 */
function processEnemyHit(room, enemy, baseDamage, element, attackerId) {
  if (!enemy.alive) return 0;

  const w              = room.wave;
  const now            = Date.now();
  const prev           = w.lastHitMap.get(enemy.id);
  const comboWindowMs  = B.game.comboWindowMs  ?? 1500;
  const comboDamageMult = B.game.comboDamageMult ?? 1.35;

  let finalDamage = baseDamage;
  let isCombo     = false;
  let surgeMult   = 1.0;
  let surgeKey    = null;

  // ① 협동 콤보 + elemental_surge ─────────────────────────────────────────────
  if (prev && prev.attackerId !== attackerId && (now - prev.timestamp) <= comboWindowMs) {
    isCombo = true;
    // 속성 조합이 다를 때만 surge 계산
    if (prev.element && element && prev.element !== element) {
      surgeKey  = `${prev.element}+${element}`;
      surgeMult = (B.game.coComboSurge || {})[surgeKey] ?? 1.0;
    }
    finalDamage = Math.round(baseDamage * comboDamageMult * surgeMult);
    console.log(
      `[co_combo_hit] ${prev.attackerId}(${prev.element ?? 'none'})+${attackerId}(${element ?? 'none'})` +
      ` → ${enemy.id}  dmg ${baseDamage}→${finalDamage}` +
      (surgeKey ? ` surge:${surgeKey}(×${surgeMult})` : ` combo:×${comboDamageMult}`)
    );
  }
  // ① solo_combo: 1인 세션 대체 메카닉 — 동일 플레이어가 comboWindowMs 내 동일 적 연속 히트
  else if (prev && prev.attackerId === attackerId && (now - prev.timestamp) <= comboWindowMs
           && Object.keys(room.players).length === 1) {
    finalDamage = Math.round(baseDamage * comboDamageMult);
    const comboBonus = finalDamage - baseDamage;
    console.log(
      `[solo_combo_hit] ${attackerId} → ${enemy.id}  combo_bonus:+${comboBonus}` +
      `  dmg ${baseDamage}→${finalDamage}  (×${comboDamageMult})`
    );
    sendTo(room, attackerId, {
      type: 'solo_combo_hit', targetId: enemy.id, attackerId, damage: finalDamage,
    });
  }

  // ② 방패 방어 패턴: 방어 중이면 피해 감소 적용 ──────────────────────────────
  if (enemy.type === 'shield' && enemy.shieldDefenseTimer > 0) {
    const reduction   = (B.enemies.shield && B.enemies.shield.shieldDamageReduction) ?? 0.5;
    const afterBlock  = Math.max(1, Math.round(finalDamage * (1 - reduction)));
    console.log(
      `[shield] ${enemy.id} defensive block: ${finalDamage}→${afterBlock}` +
      ` (${Math.round(reduction * 100)}% absorbed, timer=${enemy.shieldDefenseTimer})`
    );
    finalDamage = afterBlock;
  }

  // ③ lastHitMap 갱신: element 포함 저장 (다음 콤보 surge 계산용) ──────────────
  w.lastHitMap.set(enemy.id, { attackerId, element, timestamp: now });

  // DDA 보조 지표: 플레이어 주문 명중 카운트 (attackerId 있으면 플레이어 기원)
  if (room.metrics && attackerId) room.metrics.spellsHit++;

  enemy.hp -= finalDamage;

  // hit: broadcast (공유 상태 — 적 HP·이펙트 동기화)
  broadcast(room, {
    type:       'hit',
    targetId:   enemy.id,
    damage:     finalDamage,
    element,
    isEnemy:    true,
    pos:        { x: Math.round(enemy.x), y: Math.round(enemy.y) },
    attackerId,
    combo:      isCombo,
  });

  // co_combo_hit: broadcast (공유 상태 — 협동 콤보 + elemental_surge 시각화)
  if (isCombo) {
    broadcast(room, {
      type:           'co_combo_hit',
      enemyId:        enemy.id,
      players:        [prev.attackerId, attackerId],
      elements:       [prev.element ?? null, element ?? null],
      damage:         finalDamage,
      comboDamageMult,
      elementalSurge: surgeKey ? { key: surgeKey, mult: surgeMult } : null,
      pos:            { x: Math.round(enemy.x), y: Math.round(enemy.y) },
    });
  }

  if (enemy.hp <= 0) killEnemy(room, enemy);
  return finalDamage;
}

// ─── Spell Casting ────────────────────────────────────────────────────────────
function castSpell(room, player, shape, spellDef, confidence, tier) {
  const p    = B.player;
  const cost = p.spellManaCost;
  if (player.mana < cost) return false;

  player.mana -= cost;
  const cd = Math.round(p.spellCooldownTicks * player.cooldownMultiplier);
  player.spellCooldown = cd;

  const tierMult = tier?.damageMult ?? 1.0;
  const dmgBase  = Math.round(p.baseSpellDamage * player.damageMultiplier * (spellDef.damageMult || 1.0) * tierMult);
  const elem     = player.element;
  const type     = spellDef.type;
  const enemies  = room.wave.enemies.filter(e => e.alive);

  // ── PULSE: instant AoE ────────────────────────────────────────────────────
  if (type === 'pulse') {
    const radius = (spellDef.aoeRadius || 130) + player.pulseRangeBonus;
    let hits = 0;
    for (const e of enemies) {
      if (dist2(player.x, player.y, e.x, e.y) <= radius) {
        const dmg = calcDamage(dmgBase, elem, e.element);
        hits++;
        processEnemyHit(room, e, dmg, elem, player.id);
      }
    }
    broadcast(room, {
      type: 'spell_cast', playerId: player.id,
      spellType: 'pulse', shape, element: elem,
      x: player.x, y: player.y, radius, hits,
      label: spellDef.label, confidence, tier: tier?.label,
    });
    return true;
  }

  // ── CHAIN: sequential jump ────────────────────────────────────────────────
  if (type === 'chain') {
    const chainCount = (spellDef.chainCount || 3) + player.chainBonus;
    let pool = [...enemies];
    let lx = player.x, ly = player.y;
    const links = [];
    for (let i = 0; i < chainCount && pool.length > 0; i++) {
      const t = pool.reduce((a, b) =>
        dist2(lx, ly, a.x, a.y) < dist2(lx, ly, b.x, b.y) ? a : b
      );
      const dmg       = calcDamage(Math.round(dmgBase * (0.85 ** i)), elem, t.element);
      const actualDmg = processEnemyHit(room, t, dmg, elem, player.id);
      links.push({ from: { x: lx, y: ly }, to: { x: t.x, y: t.y }, targetId: t.id, damage: actualDmg });
      lx = t.x; ly = t.y;
      pool = pool.filter(e => e.alive && e !== t);
    }
    broadcast(room, {
      type: 'spell_cast', playerId: player.id,
      spellType: 'chain', shape, element: elem,
      x: player.x, y: player.y, links,
      label: spellDef.label, confidence, tier: tier?.label,
    });
    return true;
  }

  // ── NOVA: multi-direction projectiles ─────────────────────────────────────
  if (type === 'nova') {
    const count = (spellDef.count || 8) + player.novaBonusCount;
    const spd   = p.spellSpeed;
    for (let i = 0; i < count; i++) {
      const angle = (2 * Math.PI * i) / count;
      room.wave.spells.push({
        id: genId('sp'), ownerId: player.id,
        element: elem, spellType: 'nova', shape,
        damage:   dmgBase,
        x: player.x, y: player.y,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd,
        radius:   p.spellRadius,
        lifetime: p.spellLifetimeTicks,
        piercing: spellDef.piercing || false,
        pierceRemaining: spellDef.piercing ? (1 + player.pierceBonus) : 0,
      });
    }
    broadcast(room, {
      type: 'spell_cast', playerId: player.id,
      spellType: 'nova', shape, element: elem,
      x: player.x, y: player.y, count,
      label: spellDef.label, confidence, tier: tier?.label,
    });
    return true;
  }

  // ── BOLT / PIERCE: targeted projectile(s) ────────────────────────────────
  if (!enemies.length) {
    player.mana += cost; player.spellCooldown = 0;
    return false;
  }

  const nearest = enemies.reduce((a, b) =>
    dist2(player.x, player.y, a.x, a.y) < dist2(player.x, player.y, b.x, b.y) ? a : b
  );
  const baseAngle = Math.atan2(nearest.y - player.y, nearest.x - player.x);

  let count = spellDef.count || 1;
  if (player.dualCast && type === 'bolt') count = Math.max(count, 2);

  const isPierce = spellDef.piercing || type === 'pierce';
  for (let i = 0; i < count; i++) {
    const spread = count > 1 ? (i - (count - 1) / 2) * 0.18 : 0;
    room.wave.spells.push({
      id: genId('sp'), ownerId: player.id,
      element: elem, spellType: type, shape,
      damage:   dmgBase,
      x: player.x, y: player.y,
      vx: Math.cos(baseAngle + spread) * p.spellSpeed,
      vy: Math.sin(baseAngle + spread) * p.spellSpeed,
      radius:   p.spellRadius,
      lifetime: p.spellLifetimeTicks,
      piercing: isPierce,
      pierceRemaining: isPierce ? (2 + player.pierceBonus) : 0,
    });
  }
  broadcast(room, {
    type: 'spell_cast', playerId: player.id,
    spellType: type, shape, element: elem,
    x: player.x, y: player.y, count,
    label: spellDef.label, confidence, tier: tier?.label,
  });
  return true;
}

// ─── draw_end Logic ───────────────────────────────────────────────────────────
/**
 * handleDrawEnd — async.
 * mlInfer(pts)가 Promise를 반환하므로 await 필수.
 * 모든 서버→클라이언트 spell_result/shape_recognized 페이로드에
 *   fallback: boolean 포함 → 프론트가 분기 없이 읽을 수 있음.
 */
async function handleDrawEnd(room, player) {
  player.drawing = false;
  const pts = player.drawPoints;
  player.drawPoints = [];

  // mlInfer: FastAPI 우선, 실패 시 로컬 heuristic 자동 전환
  const { shape, confidence, fallback } = await mlInfer(pts);
  const fb = !!fallback;   // JSON-safe boolean

  if (!shape) {
    sendTo(room, player.id, {
      type: 'spell_result', success: false,
      reason: fb ? 'ml_fallback' : 'unrecognized',
      confidence,   // NaN → null in JSON; 클라이언트 tier 매핑용
      fallback: fb,
    });
    return;
  }

  // ① Check shape unlock — reject locked shapes with specific error
  const unlocked = player.unlockedShapes || [];
  if (!unlocked.includes(shape)) {
    sendTo(room, player.id, {
      type: 'spell_result', success: false, reason: 'shape_locked',
      shape, confidence, fallback: fb,
      unlockedShapes: unlocked,
      hint: '증강을 선택해 이 도형을 해금하세요',
    });
    return;
  }

  // Broadcast recognition immediately (visual feedback)
  // fallback 포함 → VFX가 폴백 여부로 이펙트 분기 가능
  broadcast(room, { type: 'shape_recognized', playerId: player.id, shape, confidence, fallback: fb });

  const singleTier = getConfidenceTier(isFinite(confidence) ? confidence : 0);
  if (singleTier.damageMult === 0.0) {
    sendTo(room, player.id, {
      type: 'spell_result', success: false, reason: 'failed_draw',
      shape, confidence, fallback: fb, tier: singleTier.label,
    });
    return;
  }

  if (player.mana < B.player.spellManaCost) {
    sendTo(room, player.id, {
      type: 'spell_result', success: false, reason: 'no_mana',
      shape, confidence, fallback: fb, tier: singleTier.label,
    });
    return;
  }
  if (player.spellCooldown > 0) {
    sendTo(room, player.id, {
      type: 'spell_result', success: false, reason: 'cooldown',
      shape, confidence, fallback: fb, tier: singleTier.label,
    });
    return;
  }

  const now = Date.now();
  const pending = player.pendingShape;
  const inWindow = pending && (now - pending.time < B.game.compositeWindowMs);
  const compositeKey = inWindow ? `${pending.shape}+${shape}` : null;
  const compositeDef = compositeKey ? B.compositeSpells[compositeKey] : null;

  let spellDef, isComposite, effectiveConfidence;
  if (compositeDef) {
    spellDef            = compositeDef;
    isComposite         = true;
    effectiveConfidence = ((pending.confidence ?? confidence) + confidence) / 2;
    player.pendingShape = null;
  } else {
    spellDef            = B.shapeSpells[shape];
    isComposite         = false;
    effectiveConfidence = confidence;
    player.pendingShape = { shape, time: now, confidence };
  }

  const safConf = isFinite(effectiveConfidence) ? effectiveConfidence : 0;
  const tier    = getConfidenceTier(safConf);

  if (!spellDef) {
    sendTo(room, player.id, {
      type: 'spell_result', success: false, reason: 'no_spell',
      shape, confidence: safConf, fallback: fb, tier: tier.label,
    });
    return;
  }

  // castSpell이 ML confidence(→ tier → damageMult)를 반영해 실제 데미지 결정
  const ok = castSpell(room, player, shape, spellDef, safConf, tier);

  // ── 시전 지표 + 시너지 추적 ──────────────────────────────────────────────────
  if (ok && player.element && room.metrics) {
    const m = room.metrics;
    m.spellsAttempted++;

    // 원소 사용 빈도 누적 (패턴 카운터링용 — 세션 내내 누적)
    const eu = m.elementUseCount[player.id] || {};
    m.elementUseCount[player.id] = eu;
    eu[player.element] = (eu[player.element] || 0) + 1;

    // 2P 협동 시너지 체크 (현재 시전 기록 전에 체크해야 상대 시전과 비교됨)
    const castTime = Date.now();
    checkCoSynergy(room, player, castTime);

    // 이번 시전 기록 (다음 번 다른 플레이어의 시너지 체크용)
    m.lastSpellCast[player.id] = {
      element: player.element,
      time:    castTime,
      x:       player.x,
      y:       player.y,
    };
  }

  sendTo(room, player.id, {
    type: 'spell_result', success: ok,
    shape, spellType: spellDef.type,
    isComposite, label: spellDef.label,
    element: player.element,
    compositeKey: isComposite ? compositeKey : null,
    confidence: safConf, fallback: fb, tier: tier.label,
  });
}

// ─── Enemy AI ─────────────────────────────────────────────────────────────────
function updateEnemies(room) {
  const w = room.wave;
  const alivePlayers = Object.values(room.players).filter(p => p.alive);
  const aliveEnemies = w.enemies.filter(e => e.alive);
  const AW = B.game.arenaWidth, AH = B.game.arenaHeight;
  const windupTicks  = B.game.attackWindupTicks || 4;

  for (const e of aliveEnemies) {
    // ── Healer: heal nearby allies (AI: 아군 HP 회복) ────────────────────────
    if (e.type === 'healer' && e.healRadius > 0) {
      e.healTimer++;
      if (e.healTimer >= e.attackCooldown) {
        e.healTimer = 0;
        let healCount = 0;
        for (const ally of aliveEnemies) {
          if (ally === e) continue;
          if (dist2(e.x, e.y, ally.x, ally.y) <= e.healRadius) {
            const healed = Math.min(e.healAmount, ally.maxHp - ally.hp);
            if (healed > 0) {
              ally.hp += healed;
              healCount++;
              // enemy_heal: broadcast (공유 상태 — 힐러 AI 행동 QA 재현 가능)
              broadcast(room, { type: 'enemy_heal', enemyId: ally.id, healerId: e.id, amount: healed });
            }
          }
        }
        if (healCount > 0)
          console.log(`[healer] ${e.id} healed ${healCount} allies (healRadius=${e.healRadius}, amount=${e.healAmount})`);
      }
    }

    // ── Shield: 방어 패턴 카운트다운 (AI: 공격 후 방어 모드) ────────────────────
    if (e.type === 'shield' && e.shieldDefenseTimer > 0) {
      e.shieldDefenseTimer--;
      if (e.shieldDefenseTimer === 0) {
        console.log(`[shield] ${e.id} defensive stance ended — resuming AI`);
        // shield_defense: broadcast (공유 상태 — 방어 종료 시각화)
        broadcast(room, { type: 'shield_defense', enemyId: e.id, active: false });
      }
      continue; // 방어 중: 이동·공격 없음 (방어 패턴)
    }

    if (!alivePlayers.length) continue;

    // Pick target
    let target;
    if (e.type === 'fast') {
      target = alivePlayers.reduce((a, b) => a.hp < b.hp ? a : b);
    } else {
      target = alivePlayers.reduce((a, b) =>
        dist2(e.x, e.y, a.x, a.y) < dist2(e.x, e.y, b.x, b.y) ? a : b
      );
    }
    e.targetId = target.id;

    const dx = target.x - e.x, dy = target.y - e.y;
    const d  = Math.hypot(dx, dy) || 1;
    const spd = e.speed * B.game.tickMs / 1000;

    // Move
    if (e.type === 'ranged') {
      if (d > 200)      { e.x += (dx / d) * spd; e.y += (dy / d) * spd; }
      else if (d < 130) { e.x -= (dx / d) * spd; e.y -= (dy / d) * spd; }
    } else if (d > e.attackRange) {
      e.x += (dx / d) * spd;
      e.y += (dy / d) * spd;
    }
    e.x = clamp(e.x, -80, AW + 80);
    e.y = clamp(e.y, -80, AH + 80);

    // ── Attack Cooldown + Windup Animation ────────────────────────────────
    if (e.attackTimer > 0) {
      e.attackTimer--;
      // Windup: broadcast 200ms before melee strike (windupTicks ticks before 0)
      if (e.melee && e.attackTimer === windupTicks && d <= e.attackRange * 1.6 && !e.windupSent) {
        e.windupSent = true;
        broadcast(room, {
          type: 'attack_anim', enemyId: e.id,
          phase: 'windup', targetId: target.id,
          x: e.x, y: e.y,
        });
      }
      continue;
    }
    if (d > e.attackRange) continue;

    // Reset windup guard; broadcast strike
    e.windupSent = false;
    e.attackTimer = e.attackCooldown;

    if (e.type === 'ranged') {
      const pspd = e.projectileSpeed || 12;
      w.projList.push({
        id: genId('pr'), enemyId: e.id,
        element: e.element, damage: e.damage,
        x: e.x, y: e.y,
        vx: (dx / d) * pspd, vy: (dy / d) * pspd,
        radius: 8, lifetime: 80,
      });
    } else {
      // Melee: broadcast strike then deal damage
      broadcast(room, {
        type: 'attack_anim', enemyId: e.id,
        phase: 'strike', targetId: target.id,
        x: e.x, y: e.y,
      });

      // ── Shield: 공격 횟수 추적 → 방어 패턴 진입 ────────────────────────────
      if (e.type === 'shield') {
        e.shieldAttackCount++;
        const trigger  = (B.enemies.shield && B.enemies.shield.shieldDefenseTrigger) ?? 3;
        const defTicks = (B.enemies.shield && B.enemies.shield.shieldDefenseTicks) ?? 40;
        if (e.shieldAttackCount >= trigger) {
          e.shieldAttackCount  = 0;
          e.shieldDefenseTimer = defTicks;
          console.log(
            `[shield] ${e.id} entered defensive stance ` +
            `(${defTicks} ticks = ${defTicks * B.game.tickMs}ms, after ${trigger} attacks)`
          );
          // shield_defense: broadcast (공유 상태 — 방어 진입 시각화)
          broadcast(room, {
            type: 'shield_defense', enemyId: e.id,
            active: true, durationMs: defTicks * B.game.tickMs,
          });
        }
      }

      if (target.invincible > 0) continue;
      const dmg = calcDamage(e.damage, e.element, null);
      target.hp = Math.max(0, target.hp - dmg);
      target.invincible = B.player.invincibleTicksOnHit;
      if (room.metrics) room.metrics.damageTaken += dmg;   // DDA: 근접 피해 누적
      broadcast(room, { type: 'hit', targetId: target.id, damage: dmg, element: e.element,
        pos: { x: Math.round(target.x), y: Math.round(target.y) },
        attackerPos: { x: Math.round(e.x), y: Math.round(e.y) } });
      if (target.hp <= 0) killPlayer(room, target);
    }
  }
}

// ─── Update Spells & Projectiles ─────────────────────────────────────────────
function updateProjectiles(room) {
  const w = room.wave;
  const AW = B.game.arenaWidth, AH = B.game.arenaHeight;

  // Player spells
  for (let i = w.spells.length - 1; i >= 0; i--) {
    const s = w.spells[i];
    s.x += s.vx; s.y += s.vy;
    s.lifetime--;

    if (s.lifetime <= 0 || s.x < -120 || s.x > AW + 120 || s.y < -120 || s.y > AH + 120) {
      w.spells.splice(i, 1); continue;
    }

    let removeSpell = false;
    for (const e of w.enemies) {
      if (!e.alive) continue;
      if (dist2(s.x, s.y, e.x, e.y) >= s.radius + e.radius) continue;

      const dmg = calcDamage(s.damage, s.element, e.element);
      processEnemyHit(room, e, dmg, s.element, s.ownerId);

      if (s.piercing && s.pierceRemaining > 0) {
        s.pierceRemaining--;
      } else {
        removeSpell = true; break;
      }
    }
    if (removeSpell) w.spells.splice(i, 1);
  }

  // Enemy projectiles
  for (let i = w.projList.length - 1; i >= 0; i--) {
    const pr = w.projList[i];
    pr.x += pr.vx; pr.y += pr.vy;
    pr.lifetime--;

    if (pr.lifetime <= 0 || pr.x < -120 || pr.x > AW + 120 || pr.y < -120 || pr.y > AH + 120) {
      w.projList.splice(i, 1); continue;
    }

    let hit = false;
    for (const p of Object.values(room.players)) {
      if (!p.alive || p.invincible > 0) continue;
      if (dist2(pr.x, pr.y, p.x, p.y) < pr.radius + B.player.playerRadius) {
        const dmg = calcDamage(pr.damage, pr.element, null);
        p.hp = Math.max(0, p.hp - dmg);
        p.invincible = B.player.invincibleTicksOnHit;
        if (room.metrics) room.metrics.damageTaken += dmg;   // DDA: 프로젝타일 피해 누적
        broadcast(room, { type: 'hit', targetId: p.id, damage: dmg, element: pr.element,
          pos: { x: Math.round(p.x), y: Math.round(p.y) },
          attackerPos: { x: Math.round(pr.x), y: Math.round(pr.y) } });
        if (p.hp <= 0) killPlayer(room, p);
        hit = true; break;
      }
    }
    if (hit) w.projList.splice(i, 1);
  }
}

// ─── Player Update ────────────────────────────────────────────────────────────
function updatePlayers(room) {
  for (const p of Object.values(room.players)) {
    if (!p.alive) continue;
    if (p.invincible > 0) p.invincible--;

    const dx = p.targetX - p.x, dy = p.targetY - p.y;
    const d  = Math.hypot(dx, dy);
    const spd = B.player.speedPerTick;
    if (d > spd) {
      p.x += (dx / d) * spd;
      p.y += (dy / d) * spd;
    } else {
      p.x = p.targetX; p.y = p.targetY;
    }
    p.x = clamp(p.x, 20, B.game.arenaWidth  - 20);
    p.y = clamp(p.y, 20, B.game.arenaHeight - 20);

    p.mana = Math.min(p.maxMana, p.mana + B.player.manaRegenPerTick * p.manaRegenMultiplier);
    if (p.spellCooldown > 0) p.spellCooldown--;

    if (!p.connected) {
      p.disconnectTimer--;
      if (p.disconnectTimer <= 0) killPlayer(room, p);
    }

    if (p.pendingShape && Date.now() - p.pendingShape.time > B.game.compositeWindowMs) {
      p.pendingShape = null;
    }
  }
}

// ─── DDA (동적 난이도 조정) ─────────────────────────────────────────────────────
/**
 * computeDDA — 파동 종료 시 호출. 플레이어 수신 피해 비율을 기준으로
 * room.metrics.ddaScale을 ±adjustStep 범위 내 조정 (maxScaleDown~maxScaleUp 클램프).
 * 결과는 다음 startWave에서 적 수·HP에 적용.
 */
function computeDDA(room) {
  const cfg = B.dda;
  if (!cfg || cfg.enabled === false) return;
  const m = room.metrics;
  if (!m) return;

  const players  = Object.values(room.players);
  const n        = Math.max(1, players.length);
  const avgMaxHp = players.reduce((s, p) => s + p.maxHp, 0) / n;

  // 핵심 지표: 파동 동안 플레이어가 받은 총 피해 / (플레이어 수 × 평균 최대HP)
  const damageTakenRate = m.damageTaken / Math.max(1, n * avgMaxHp);
  const target   = cfg.damageTakenRateTarget ?? 0.35;
  const step     = cfg.adjustStep   ?? 0.10;
  const maxUp    = cfg.maxScaleUp   ?? 1.20;
  const maxDown  = cfg.maxScaleDown ?? 0.80;

  const oldScale = m.ddaScale;
  if (damageTakenRate < target * 0.5) {
    // 피해 매우 적음 → 너무 쉬움 → 다음 파동 난이도 상향
    m.ddaScale = Math.min(m.ddaScale + step, maxUp);
  } else if (damageTakenRate > target * 1.5) {
    // 피해 과다 → 너무 어려움 → 다음 파동 난이도 하향
    m.ddaScale = Math.max(m.ddaScale - step, maxDown);
  }

  console.log(
    `[DDA] wave=${room.wave.number}` +
    ` damageTakenRate=${damageTakenRate.toFixed(2)}` +
    ` (taken=${m.damageTaken} pool=${Math.round(n * avgMaxHp)})` +
    ` spells=${m.spellsAttempted} hits=${m.spellsHit}` +
    ` scale ${oldScale.toFixed(2)}→${m.ddaScale.toFixed(2)}`
  );
}

// ─── 패턴 카운터링 ────────────────────────────────────────────────────────────
/**
 * applyPatternCounter — 세션 내 지배적 원소를 찾아 내성 적 원소를 스폰 큐에 적용.
 * 화염을 많이 쓰면 물 원소 적(화염이 0.7× 약화) 비중을 점진 증가.
 * elemental_surge·보스 파동은 호출하지 않음.
 */
function applyPatternCounter(room, spawnQueue) {
  const cfg = B.patternCounter;
  if (!cfg || cfg.enabled === false) return spawnQueue;
  const m = room.metrics;
  if (!m) return spawnQueue;

  // 모든 플레이어 원소 사용량 합산
  const totalUse = {};
  for (const elemMap of Object.values(m.elementUseCount || {})) {
    for (const [elem, count] of Object.entries(elemMap)) {
      totalUse[elem] = (totalUse[elem] || 0) + count;
    }
  }
  const entries = Object.entries(totalUse).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return spawnQueue;

  const [dominantElem, dominantCount] = entries[0];
  if (dominantCount < (cfg.thresholdCasts ?? 5)) return spawnQueue;

  const counterElem = (cfg.counterElement || {})[dominantElem];
  if (!counterElem) return spawnQueue;

  const maxFraction = cfg.maxResistFraction ?? 0.40;
  const resistTypes = cfg.resistantEnemyTypes || ['basic', 'fast', 'tank', 'ranged'];

  // 사용 횟수가 많을수록 fraction 증가 (최대 maxFraction)
  const fraction = Math.min(dominantCount / 20, maxFraction);

  // 오버라이드 대상: 보스 제외, 지정 타입, 아직 원소 미지정
  const eligible = spawnQueue
    .map((def, i) => ({ def, i }))
    .filter(({ def }) =>
      def.type !== 'boss' &&
      resistTypes.includes(def.type) &&
      !def.element
    );

  const overrideCount = Math.floor(eligible.length * fraction);
  if (overrideCount === 0) return spawnQueue;

  const result = [...spawnQueue];
  for (let k = 0; k < overrideCount; k++) {
    result[eligible[k].i] = { ...eligible[k].def, element: counterElem };
  }
  console.log(
    `[patternCounter] dominant=${dominantElem}(${dominantCount}x)` +
    ` → counter=${counterElem} applied=${overrideCount}/${spawnQueue.length}` +
    ` (fraction=${fraction.toFixed(2)})`
  );
  return result;
}

// ─── 2P 협동 시너지 ───────────────────────────────────────────────────────────
/**
 * triggerCoSynergy — 시너지 버스트 실행.
 * 시전자 주변 burstRadius 내 적에게 burstDmg(속성 상성 적용) 적용 후
 * co_synergy_burst 이벤트 브로드캐스트.
 *
 * 이벤트 스펙 (프론트엔드 소비용 — 필드명 불변):
 *   { type:'co_synergy_burst', elem1, elem2, x, y, dmg }
 */
function triggerCoSynergy(room, caster, elem1, elem2) {
  const cfg         = B.coSynergy;
  const burstDmg    = cfg.burstDmg    ?? 60;
  const burstRadius = cfg.burstRadius ?? 200;

  const enemies = room.wave.enemies.filter(e => e.alive);
  let appliedDmg = 0;
  for (const e of enemies) {
    if (dist2(caster.x, caster.y, e.x, e.y) <= burstRadius) {
      const dmg = calcDamage(burstDmg, elem1, e.element);
      processEnemyHit(room, e, dmg, elem1, caster.id);
      appliedDmg += dmg;
    }
  }

  const payload = {
    type: 'co_synergy_burst',
    elem1,
    elem2,
    x:   Math.round(caster.x),
    y:   Math.round(caster.y),
    dmg: appliedDmg || burstDmg,
  };
  broadcast(room, payload);
  console.log(
    `[co_synergy] ${elem1}+${elem2} burst at (${payload.x},${payload.y})` +
    ` dmg=${payload.dmg} enemies_hit=${appliedDmg > 0 ? '≥1' : '0'}`
  );
}

/**
 * checkCoSynergy — 현재 시전자의 원소와 다른 플레이어의 최근 시전을 비교.
 * comboPairs에 해당하고 windowMs 이내면 triggerCoSynergy 발동.
 * 발동 후 cooldownMs 동안 재발동 차단.
 */
function checkCoSynergy(room, caster, now) {
  const cfg = B.coSynergy;
  if (!cfg || cfg.enabled === false) return;
  if (Object.keys(room.players).length < 2) return;   // 2P 이상에서만 유효
  if (now < (room.metrics.synergyCooldown || 0)) return;
  if (!caster.element) return;

  const windowMs   = cfg.windowMs ?? 3000;
  const comboPairs = cfg.comboPairs || [];
  const lastCasts  = room.metrics.lastSpellCast;

  for (const [pid, lastCast] of Object.entries(lastCasts)) {
    if (pid === caster.id) continue;
    if (now - lastCast.time > windowMs) continue;
    const e1 = caster.element, e2 = lastCast.element;
    if (!e2) continue;
    if (!comboPairs.some(([a, b]) => a === e1 && b === e2)) continue;

    // 시너지 조건 충족 → 발동
    triggerCoSynergy(room, caster, e1, e2);
    room.metrics.synergyCooldown = now + (cfg.cooldownMs ?? 8000);
    break;  // 한 턴에 하나만
  }
}

// ─── 세션 리더보드 ────────────────────────────────────────────────────────────
/**
 * saveLeaderboard — 게임 종료 시 호출.
 * 최고 웨이브·총 킬·최장 콤보를 leaderboard[]에 저장(최대 LEADERBOARD_MAX개).
 * 저장 즉시 'leaderboard' WebSocket 이벤트 브로드캐스트.
 *
 * GET /leaderboard REST 엔드포인트와 동일한 데이터를 공유.
 */
function saveLeaderboard(room) {
  const m = room.metrics;
  if (!m) return;
  // 실제 닉네임 사용 (미설정 시 플레이어 ID)
  const playerNames = Object.values(room.players).map(p => p.nickname || p.id);
  const entry = {
    wave:        m.maxWave,
    kills:       m.totalKills,
    maxCombo:    m.maxKillCombo,
    score:       room.score,
    playerNames,
    _ts:         Date.now(),
  };
  // 유효성 검사: 음수·비정상 값 차단
  if (!Number.isFinite(entry.wave)  || entry.wave  < 0) entry.wave  = 0;
  if (!Number.isFinite(entry.kills) || entry.kills < 0) entry.kills = 0;
  if (!Number.isFinite(entry.score) || entry.score < 0) entry.score = 0;

  leaderboard.push(entry);
  leaderboard.sort((a, b) =>
    (b.score - a.score) || (b.wave - a.wave) || (b.kills - a.kills)
  );
  if (leaderboard.length > LEADERBOARD_MAX) leaderboard.length = LEADERBOARD_MAX;

  // 파일 원자 쓰기 (영속화)
  writeLeaderboardFile();

  broadcast(room, {
    type:    'leaderboard',
    entries: leaderboard.map(e => ({
      wave:        e.wave,
      kills:       e.kills,
      maxCombo:    e.maxCombo,
      score:       e.score ?? e._score ?? 0,
      playerNames: e.playerNames,
    })),
  });
  console.log(
    `[leaderboard] saved: wave=${entry.wave} kills=${entry.kills}` +
    ` score=${entry.score} players=[${playerNames.join(',')}]` +
    ` total=${leaderboard.length}/${LEADERBOARD_MAX}`
  );
}

// ─── Wave Phase Management ────────────────────────────────────────────────────
function startWave(room, waveNum) {
  B = loadBalance();
  const w = room.wave;
  w.number     = waveNum;
  w.enemies    = [];
  w.spells     = [];
  w.projList   = [];
  w.spawnQueue = buildSpawnQueue(waveNum);
  w.spawnTimer = 0;
  w.clearTimer = 0;
  w.lastHitMap = new Map();  // 콤보 트래커 웨이브마다 초기화

  // ── Elemental Surge: 3의 배수 웨이브 (보스 웨이브 제외) ──────────────────
  const isBossWave = waveNum % B.game.bossWaveInterval === 0;
  let eventType    = null;
  if (waveNum % 3 === 0 && !isBossWave) {
    eventType = 'elemental_surge';
    // SURGE_ELEMENTS → B.elements (핫리로드 반영)
    const surgeElems = B.elements || ['fire','water','lightning','earth'];
    const surgeElem  = surgeElems[(Math.floor(waveNum / 3) - 1) % surgeElems.length];
    // 스폰 큐의 모든 적을 동일 속성으로 강제 설정
    w.spawnQueue = w.spawnQueue.map(def => ({ ...def, element: surgeElem }));
    console.log(`[wave] ${waveNum} elemental_surge: ${surgeElem} (${w.spawnQueue.length} enemies) — surgeElems hotreload ok`);
  }

  // ── DDA: 적 수 조정 ──────────────────────────────────────────────────────────
  const ddaScale = (room.metrics && room.metrics.ddaScale) || 1.0;
  if (ddaScale !== 1.0) {
    const baseCount   = w.spawnQueue.length;
    const targetCount = Math.round(baseCount * ddaScale);
    const diff        = targetCount - baseCount;
    const fillElem    = eventType === 'elemental_surge' ? (w.spawnQueue[0]?.element ?? null) : null;
    if (diff > 0) {
      for (let i = 0; i < diff; i++) w.spawnQueue.push({ type: 'basic', element: fillElem });
    } else if (diff < 0) {
      // 최소 1마리 유지
      w.spawnQueue.splice(Math.max(1, baseCount + diff));
    }
  }
  w.ddaHpScale = ddaScale;   // updateWavePhase의 spawnEnemy가 HP에 적용

  // ── 플레이어 수 스케일링 (balance.json playerScalePerExtra / waveCountScalePerExtra) ─
  {
    const extraPlayers = Math.max(0, Object.keys(room.players).length - 1);
    if (extraPlayers > 0) {
      const cntMult = 1 + (B.game.waveCountScalePerExtra ?? 0.35) * extraPlayers;
      const hpMult  = 1 + (B.game.playerScalePerExtra    ?? 0.45) * extraPlayers;
      // 스폰 수 확장
      const baseCnt    = w.spawnQueue.length;
      const targetCnt  = Math.round(baseCnt * cntMult);
      const addCnt     = Math.max(0, targetCnt - baseCnt);
      const peFillElem = eventType === 'elemental_surge'
                           ? (w.spawnQueue[0]?.element ?? null) : null;
      for (let i = 0; i < addCnt; i++) w.spawnQueue.push({ type: 'basic', element: peFillElem });
      // HP 배율 합산 (ddaScale 위에 곱산)
      w.ddaHpScale = (w.ddaHpScale || 1.0) * hpMult;
      console.log(
        `[playerScale] players=${extraPlayers + 1} extra=${extraPlayers}` +
        ` cntScale=×${cntMult.toFixed(2)} hpMult=×${hpMult.toFixed(2)}` +
        ` spawn=${w.spawnQueue.length} hpScale=${w.ddaHpScale.toFixed(2)}`
      );
    }
  }

  // ── 패턴 카운터 (elemental_surge·보스 파동 제외) ─────────────────────────────
  if (!eventType && !isBossWave && room.metrics) {
    w.spawnQueue = applyPatternCounter(room, w.spawnQueue);
  }

  // ── 파동 지표 리셋 + maxWave 갱신 ────────────────────────────────────────────
  if (room.metrics) {
    room.metrics.maxWave         = Math.max(room.metrics.maxWave, waveNum);
    room.metrics.damageTaken     = 0;
    room.metrics.spellsAttempted = 0;
    room.metrics.spellsHit       = 0;
    room.metrics.waveStartHp     = Object.fromEntries(
      Object.entries(room.players).map(([pid, p]) => [pid, p.hp])
    );
  }

  const hasBoss = w.spawnQueue.some(e => e.type === 'boss');
  room.phase = 'playing';
  broadcast(room, {
    type: 'wave_start', waveNumber: waveNum,
    enemyCount: w.spawnQueue.length, hasBoss,
    ddaScale,                          // 클라이언트 wave_start 페이로드 (1.0=기준)
    ...(eventType ? { eventType } : {}),
  });
}

function checkWaveClear(room) {
  const w = room.wave;
  if (w.spawnQueue.length > 0 || w.enemies.some(e => e.alive)) return;
  if (room.phase !== 'playing') return;

  computeDDA(room);    // DDA: 이번 파동 성과 분석 → 다음 파동 scale 갱신
  room.phase   = 'wave_clear';
  w.clearTimer = Math.round(B.game.waveClearDelayMs / B.game.tickMs);
  broadcast(room, { type: 'wave_clear', waveNumber: w.number, score: room.score });

  // ③ Revive dead players at reviveHpPercent of maxHp
  const revivePct = B.game.reviveHpPercent || 0.3;
  for (const p of Object.values(room.players)) {
    if (!p.alive) {
      p.alive = true;
      p.hp    = Math.max(1, Math.floor(p.maxHp * revivePct));
      broadcast(room, {
        type: 'player_revive', playerId: p.id,
        hp: p.hp, maxHp: p.maxHp,
        revivePercent: revivePct,
      });
      console.log(`[revive] ${p.id} revived at ${p.hp}/${p.maxHp} HP`);
    }
  }

  // ⑤ Drain queued level-ups (show augments sequentially after wave)
  drainAugmentQueue(room);
}

function updateWavePhase(room) {
  const w = room.wave;
  if (room.phase === 'wave_clear') {
    if (--w.clearTimer <= 0) {
      room.phase  = 'wave_prep';
      w.prepTimer = Math.round(B.game.wavePrepDelayMs / B.game.tickMs);
      const countdownSec = Math.round(B.game.wavePrepDelayMs / 1000);

      // ③ next_enemies: 다음 웨이브 구성 미리계산 (elemental_surge 오버라이드 포함)
      const nextWaveNum  = w.number + 1;
      const nextQueue    = buildSpawnQueue(nextWaveNum);
      const nextIsBoss   = nextWaveNum % B.game.bossWaveInterval === 0;
      if (nextWaveNum % 3 === 0 && !nextIsBoss) {
        const surgeElems = B.elements || ['fire','water','lightning','earth'];
        const surgeElem  = surgeElems[(Math.floor(nextWaveNum / 3) - 1) % surgeElems.length];
        for (const def of nextQueue) def.element = surgeElem;
      }
      const nextEnemiesAgg = {};
      for (const def of nextQueue) {
        const k = def.type;
        if (!nextEnemiesAgg[k]) nextEnemiesAgg[k] = { type: k, count: 0, element: def.element ?? null };
        nextEnemiesAgg[k].count++;
        if (def.element && !nextEnemiesAgg[k].element) nextEnemiesAgg[k].element = def.element;
      }
      const nextEnemies = Object.values(nextEnemiesAgg);

      broadcast(room, {
        type: 'wave_prep', nextWave: nextWaveNum,
        countdown:    countdownSec,   // 클라이언트 카운트다운 표시용
        prepSeconds:  countdownSec,   // 하위호환 유지
        next_enemies: nextEnemies,    // 다음 웨이브 적 타입·수·속성 예고
      });
    }
  } else if (room.phase === 'wave_prep') {
    // ⑤ Pause prepTimer while any player has unresolved augments
    if (hasAnyPendingAugments(room)) return;
    if (--w.prepTimer <= 0) startWave(room, w.number + 1);
  } else if (room.phase === 'playing') {
    if (w.spawnQueue.length > 0) {
      w.spawnTimer++;
      const interval = Math.round(B.wave.spawnIntervalMs / B.game.tickMs);
      if (w.spawnTimer >= interval) {
        w.spawnTimer = 0;
        const def   = w.spawnQueue.shift();
        const enemy = spawnEnemy(def.type, w.number, def.element, w.ddaHpScale || 1.0);
        w.enemies.push(enemy);
        broadcast(room, {
          type: 'enemy_spawn',
          enemy: { id: enemy.id, type: enemy.type, label: enemy.label, element: enemy.element,
                   x: enemy.x, y: enemy.y, radius: enemy.radius, hp: enemy.hp, maxHp: enemy.maxHp },
        });
        if (def.type === 'boss') {
          broadcast(room, { type: 'boss_spawn', enemyId: enemy.id, element: enemy.element });
        }
      }
    }
    checkWaveClear(room);
  }
}

// ─── Advisor ──────────────────────────────────────────────────────────────────
function updateAdvisor(room) {
  room.advisorTimer++;
  const period = Math.round(B.game.advisorUpdateMs / B.game.tickMs);
  if (room.advisorTimer < period) return;
  room.advisorTimer = 0;

  const players = Object.values(room.players).filter(p => p.alive);
  const enemies = room.wave.enemies.filter(e => e.alive);
  if (!players.length || !enemies.length) { room.advisor = null; return; }

  const hasBoss   = enemies.some(e => e.type === 'boss');
  const healers   = enemies.filter(e => e.type === 'healer').length;
  const tankCount = enemies.filter(e => e.type === 'tank').length;
  const lowHp     = players.filter(p => p.hp / p.maxHp < 0.3).length;
  const noElem    = players.filter(p => !p.element).length;
  const hasLocked = players.some(p => (p.unlockedShapes || []).length < 5);

  let msg, pri;
  if (hasBoss)             { msg = '보스 집중 공격!';               pri = 'high'; }
  else if (healers)        { msg = '치유사를 먼저 처치하세요!';      pri = 'high'; }
  else if (lowHp)          { msg = '위험! 피하며 마나 충전';         pri = 'high'; }
  else if (noElem)         { msg = '레벨업으로 속성을 해금하세요';   pri = 'med';  }
  else if (hasLocked)      { msg = '증강 선택으로 도형을 해금하세요'; pri = 'med'; }
  else if (tankCount >= 2) { msg = '관통진(삼각)으로 탱커 공략!';   pri = 'med';  }
  else {
    const tips = [
      '두 진을 빠르게 이어 그려 복합 마법!',
      '속성 상성을 활용하면 데미지 +50%',
      '별 진 → 8방향 폭발, 군중 제거에 유리',
      '지그재그 진 → 연쇄 번개로 여러 적 타격',
      '웨이브 클리어 후 증강을 선택하면 다음 웨이브 시작',
    ];
    msg = tips[room.tick % tips.length]; pri = 'low';
  }

  room.advisor = { message: msg, priority: pri };
  broadcast(room, { type: 'advisor', ...room.advisor });
}

// ─── Main Game Loop ───────────────────────────────────────────────────────────
function gameLoop(room) {
  room.tick++;
  if (room.phase === 'game_over') return;
  updatePlayers(room);
  updateEnemies(room);
  updateProjectiles(room);
  updateWavePhase(room);
  updateAdvisor(room);
  broadcast(room, serialize(room));
}

// ─── Start Game ───────────────────────────────────────────────────────────────
function startGame(room) {
  const players  = Object.values(room.players);
  const AW = B.game.arenaWidth, AH = B.game.arenaHeight;
  const positions = [
    { x: 200,      y: AH / 2   },
    { x: AW - 200, y: AH / 2   },
    { x: AW / 2,   y: 200      },
    { x: AW / 2,   y: AH - 200 },
  ];
  players.forEach((pl, idx) => {
    const pos = positions[idx] || positions[0];
    pl.hp = pl.maxHp; pl.mana = pl.maxMana; pl.alive = true;
    pl.x = pl.targetX = pos.x;
    pl.y = pl.targetY = pos.y;
    // Reset augment queue on new game
    pl.levelUpQueue    = [];
    pl.pendingAugments = [];
  });
  room.score = 0;
  room.phase = 'countdown';
  broadcast(room, {
    type: 'countdown', seconds: 3,
    shapeSpells:     B.shapeSpells,
    compositeSpells: B.compositeSpells,
    augmentPool:     B.augmentPool,
    initialShapes:   B.player.initialShapes,
  });
  setTimeout(() => {
    if (room.phase !== 'countdown') return;
    startWave(room, 1);
    room.loopInterval = setInterval(() => gameLoop(room), B.game.tickMs);
  }, 3000);
}

// ─── In-room Message Handler ──────────────────────────────────────────────────
function handleMessage(room, playerId, msg) {
  const player = room.players[playerId];
  if (!player) return;

  switch (msg.type) {
    case 'move': {
      if (!['playing','wave_clear','wave_prep'].includes(room.phase)) return;
      if (!isFinite(msg.x) || !isFinite(msg.y)) return;
      player.targetX = clamp(msg.x, 20, B.game.arenaWidth  - 20);
      player.targetY = clamp(msg.y, 20, B.game.arenaHeight - 20);
      break;
    }

    case 'draw_start': {
      if (room.phase !== 'playing') return;
      player.drawing    = true;
      player.drawPoints = [];
      break;
    }

    case 'draw_point': {
      if (!player.drawing) return;
      if (!isFinite(msg.x) || !isFinite(msg.y)) return;
      if (player.drawPoints.length < 200) {
        player.drawPoints.push({
          x: clamp(msg.x, 0, B.game.arenaWidth),
          y: clamp(msg.y, 0, B.game.arenaHeight),
        });
      }
      break;
    }

    case 'draw_end': {
      if (!player.drawing) return;
      // handleDrawEnd는 async — .catch로 Promise 에러 누수 방지
      handleDrawEnd(room, player).catch(err =>
        console.error('[draw_end] unhandled:', err.message)
      );
      break;
    }

    case 'select_augment': {
      const idx = msg.index;
      if (typeof idx !== 'number' || idx < 0 || idx >= player.pendingAugments.length) return;
      const option = player.pendingAugments[idx];
      player.pendingAugments = [];
      applyAugment(player, option);

      const shapeUnlocked = (option.kind === 'shape' && option.unlocksShape) ? option.unlocksShape : null;
      if (shapeUnlocked) {
        broadcast(room, {
          type: 'shape_unlocked', playerId,
          shape: shapeUnlocked,
          label: option.label,
        });
      }

      broadcast(room, {
        type: 'augment_selected', playerId,
        option: { kind: option.kind, id: option.id, label: option.label, unlocksShape: shapeUnlocked },
        playerStats: {
          element: player.element, elements: player.elements,
          passives: player.passives, unlockedShapes: player.unlockedShapes,
          damageMultiplier: player.damageMultiplier,
          cooldownMultiplier: player.cooldownMultiplier,
          manaRegenMultiplier: player.manaRegenMultiplier,
          maxHp: player.maxHp,
          dualCast: player.dualCast, novaBonusCount: player.novaBonusCount,
          chainBonus: player.chainBonus, pierceBonus: player.pierceBonus,
          pulseRangeBonus: player.pulseRangeBonus,
        },
      });

      // Drain next queued level-up for this player (sequential display)
      if (player.levelUpQueue.length > 0) {
        drainAugmentQueue(room);
      }
      break;
    }

    case 'start_game': {
      if (playerId !== room.hostPlayerId) {
        sendTo(room, playerId, { type: 'room_error', message: 'not_host' });
        return;
      }
      if (!['lobby'].includes(room.phase)) return;
      if (Object.keys(room.players).length < 1) return;
      startGame(room);
      break;
    }

    case 'restart_game': {
      // game_over 상태에서만 재시작 허용
      if (room.phase !== 'game_over') return;

      // 방 삭제 예약 타이머 취소
      if (room.cleanupTimer) {
        clearTimeout(room.cleanupTimer);
        room.cleanupTimer = null;
      }

      // 루프가 이미 clearInterval됐지만 혹시 남은 경우 보호
      if (room.loopInterval) {
        clearInterval(room.loopInterval);
        room.loopInterval = null;
      }

      // 플레이어 상태 초기화 (닉네임·연결 상태·인덱스 보존)
      for (const [pid, p] of Object.entries(room.players)) {
        const savedNick      = p.nickname;
        const savedConnected = p.connected;
        const savedIndex     = p.index;
        room.players[pid]            = createPlayer(pid, savedIndex, savedNick);
        room.players[pid].connected  = savedConnected;
      }

      // 방 게임 상태 초기화
      room.score        = 0;
      room.advisor      = null;
      room.advisorTimer = 0;
      room.wave = {
        number:     0,
        enemies:    [],
        spells:     [],
        projList:   [],
        spawnQueue: [],
        spawnTimer: 0,
        clearTimer: 0,
        prepTimer:  0,
        lastHitMap: new Map(),
      };
      room.metrics = {
        waveStartHp: {}, damageTaken: 0, spellsAttempted: 0, spellsHit: 0,
        ddaScale: 1.0, elementUseCount: {}, lastSpellCast: {}, synergyCooldown: 0,
        totalKills: 0, maxWave: 0, currentKillCombo: 0, lastKillTime: 0, maxKillCombo: 0,
      };

      console.log(`[restart] room ${room.code} restarted by ${playerId}`);
      startGame(room);
      break;
    }

    default: break;
  }
}

// ─── HTTP Static File Server + REST API ──────────────────────────────────────
const server = http.createServer((req, res) => {
  const t0 = Date.now();
  let urlPath = req.url.split('?')[0];

  // ① REST: GET /leaderboard — 세션 리더보드 (최대 10개, 서버 재시작 전까지 유지)
  if (urlPath === '/leaderboard') {
    const body = JSON.stringify({
      leaderboard: leaderboard.map(e => ({
        wave:        e.wave,
        kills:       e.kills,
        maxCombo:    e.maxCombo,
        score:       e.score ?? e._score ?? 0,
        playerNames: e.playerNames,
      })),
      total: leaderboard.length,
      _ms:   Date.now() - t0,
    });
    res.writeHead(200, {
      'Content-Type':  'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
    return;
  }

  // ② REST: GET /api/rooms — room list, pure in-memory (≤1ms)
  if (urlPath === '/api/rooms') {
    const list = Array.from(rooms.values()).map(r => ({
      id:          r.id,
      code:        r.code,
      phase:       r.phase,
      playerCount: Object.keys(r.players).length,
      maxPlayers:  B.game.maxPlayers,
      wave:        r.wave.number,
    }));
    const body = JSON.stringify({ rooms: list, total: list.length, _ms: Date.now() - t0 });
    res.writeHead(200, {
      'Content-Type':  'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
    return;
  }

  // Static files
  if (urlPath === '/') urlPath = '/index.html';
  let filePath;
  if (urlPath === '/config/balance.json') {
    filePath = path.join(__dirname, 'config', 'balance.json');
  } else {
    filePath = path.join(__dirname, 'public', urlPath.replace(/\.\./g, ''));
  }

  const ext  = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

// ─── WebSocket Server ─────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  const playerId = genId('p');
  pendingConns.set(ws, { playerId });

  sendWs(ws, {
    type: 'connected',
    playerId,
    shapeSpells:     B.shapeSpells,
    compositeSpells: B.compositeSpells,
    augmentPool:     B.augmentPool,
    initialShapes:   B.player.initialShapes,
    // drawingConfig: 클라이언트가 confidenceTiers를 서버에서 받아 하드코딩 0.65 제거
    drawingConfig: {
      confidenceTiers:  B.drawing.confidenceTiers,
      minPassThreshold: B.drawing.minPassThreshold,
    },
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    // ── Reconnect ──────────────────────────────────────────────────────────
    if (msg.type === 'reconnect') {
      const targetId = msg.playerId;
      for (const r of rooms.values()) {
        if (r.players[targetId]) {
          const old = r.wsMap[targetId];
          if (old && old !== ws) try { old.close(); } catch (_) {}
          r.wsMap[targetId] = ws;
          r.players[targetId].connected = true;
          r.players[targetId].disconnectTimer = 0;
          pendingConns.delete(ws);
          sendWs(ws, {
            type: 'reconnected', playerId: targetId,
            playerIndex: r.players[targetId].index,
            roomId: r.id, roomCode: r.code, phase: r.phase,
            unlockedShapes: r.players[targetId].unlockedShapes,
          });
          return;
        }
      }
      sendWs(ws, { type: 'error', message: 'session_not_found' });
      return;
    }

    // ── Create Room ────────────────────────────────────────────────────────
    if (msg.type === 'create_room') {
      const pending = pendingConns.get(ws);
      if (!pending) return;
      const code = genRoomCode();
      const room = createRoomObj(code);
      rooms.set(room.id, room);
      roomsByCode.set(code, room);

      // 닉네임: 최대 16자 trim, 미제공 시 기본값
      const rawNick1 = typeof msg.nickname === 'string' ? msg.nickname.trim().slice(0, 16) : '';
      const nickname1 = rawNick1 || 'Player1';

      const pid = pending.playerId;
      room.players[pid]     = createPlayer(pid, 0, nickname1);
      room.wsMap[pid]       = ws;
      room.hostPlayerId     = pid;
      room.players[pid].connected = true;
      pendingConns.delete(ws);

      sendWs(ws, {
        type: 'room_created',
        roomCode: code, roomId: room.id,
        playerId: pid, playerIndex: 0, isHost: true,
        nickname: nickname1,
        maxPlayers: B.game.maxPlayers,
        initialShapes: B.player.initialShapes,
      });
      console.log(`[room] created ${code} by ${pid} (${nickname1})`);
      return;
    }

    // ── Join Room ──────────────────────────────────────────────────────────
    if (msg.type === 'join_room') {
      const pending = pendingConns.get(ws);
      if (!pending) return;
      const code = (String(msg.roomCode || '')).toUpperCase().trim();
      const room = roomsByCode.get(code);

      if (!room) {
        sendWs(ws, { type: 'room_error', message: 'room_not_found', roomCode: code });
        return;
      }
      if (room.phase !== 'lobby') {
        sendWs(ws, { type: 'room_error', message: 'game_already_started' });
        return;
      }
      // ② 5번째 입장 → room_full
      if (Object.keys(room.players).length >= B.game.maxPlayers) {
        sendWs(ws, { type: 'room_error', message: 'room_full', maxPlayers: B.game.maxPlayers });
        return;
      }

      const pid   = pending.playerId;
      const index = Object.keys(room.players).length;

      // 닉네임: 최대 16자 trim, 미제공 시 인덱스 기반 기본값
      const rawNickJ  = typeof msg.nickname === 'string' ? msg.nickname.trim().slice(0, 16) : '';
      const nicknameJ = rawNickJ || `Player${index + 1}`;

      room.players[pid]     = createPlayer(pid, index, nicknameJ);
      room.wsMap[pid]       = ws;
      room.players[pid].connected = true;
      pendingConns.delete(ws);

      sendWs(ws, {
        type: 'room_joined',
        roomCode: code, roomId: room.id,
        playerId: pid, playerIndex: index, isHost: false,
        nickname: nicknameJ,
        playerCount: Object.keys(room.players).length,
        maxPlayers:  B.game.maxPlayers,
        initialShapes: B.player.initialShapes,
        tutorial_required: true,
        availableElements: B.elements || ['fire','water','lightning','earth'],
      });
      broadcast(room, {
        type: 'player_joined', playerId: pid, playerIndex: index,
        nickname: nicknameJ,
        playerCount: Object.keys(room.players).length,
        maxPlayers:  B.game.maxPlayers,
      });
      console.log(`[room] ${pid} (${nicknameJ}) joined ${code} (${index + 1}/${B.game.maxPlayers})`);
      return;
    }

    // ── In-room: find which room this ws belongs to ────────────────────────
    let playerRoom = null, playerIdInRoom = null;
    for (const r of rooms.values()) {
      for (const [pid, rws] of Object.entries(r.wsMap)) {
        if (rws === ws) { playerRoom = r; playerIdInRoom = pid; break; }
      }
      if (playerRoom) break;
    }
    if (!playerRoom) return;
    handleMessage(playerRoom, playerIdInRoom, msg);
  });

  ws.on('close', () => {
    if (pendingConns.has(ws)) { pendingConns.delete(ws); return; }

    for (const room of rooms.values()) {
      for (const [pid, rws] of Object.entries(room.wsMap)) {
        if (rws !== ws) continue;

        const p = room.players[pid];
        if (p) {
          p.connected = false;
          if (room.phase === 'lobby') {
            delete room.players[pid];
            delete room.wsMap[pid];
            if (Object.keys(room.players).length === 0) {
              rooms.delete(room.id);
              roomsByCode.delete(room.code);
              console.log(`[room] ${room.code} removed (empty)`);
            } else {
              if (room.hostPlayerId === pid) {
                room.hostPlayerId = Object.keys(room.players)[0];
                broadcast(room, { type: 'host_changed', newHostId: room.hostPlayerId });
              }
              broadcast(room, {
                type: 'player_left', playerId: pid,
                playerCount: Object.keys(room.players).length,
              });
            }
          } else {
            p.disconnectTimer = Math.round(B.game.reconnectTimeoutMs / B.game.tickMs);
            broadcast(room, { type: 'player_disconnect', playerId: pid });
          }
        }
        return;
      }
    }
  });

  ws.on('error', (e) => console.error('[ws] error:', e.message));
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎮 Wave Defense Server  http://localhost:${PORT}`);
  console.log(`   Balance: ${BALANCE_PATH}`);
  console.log(`   Tick: ${B.game.tickMs}ms (${1000 / B.game.tickMs}Hz)`);
  console.log(`   MaxPlayers: ${B.game.maxPlayers}  ReviveHP: ${B.game.reviveHpPercent * 100}%`);
  console.log(`   InitialShapes: ${(B.player.initialShapes || []).join(', ')}`);
  console.log(`   Windup: ${B.game.attackWindupTicks} ticks (${B.game.attackWindupTicks * B.game.tickMs}ms)\n`);
});
