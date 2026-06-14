'use strict';
/**
 * Unit tests: confidence NaN/undefined defense + CB boundary (Goal #5)
 * validateMlOutput + getConfidenceTier inline-copy mirrors server.js.
 * Run: node test_confidence.js
 */

// ── Inline copy: validateMlOutput (mirrors server.js) ────────────────────────
function validateMlOutput(raw) {
  let { shape = null, confidence } = raw || {};
  if (typeof shape !== 'string') shape = null;
  // NEVER Number(): Number(null)===0 silent bug blocked.
  if (typeof confidence !== 'number' || !isFinite(confidence)) {
    confidence = NaN;
  }
  return { shape, confidence };
}

// ── Inline copy: getConfidenceTier (mirrors server.js + balance.json) ─────────
const TIERS = [
  { min: 0.0,  max: 0.40, damageMult: 0.0, label: '실패' },
  { min: 0.40, max: 0.65, damageMult: 0.7, label: '약화' },
  { min: 0.65, max: 0.80, damageMult: 1.0, label: '정상' },
  { min: 0.80, max: 1.01, damageMult: 1.3, label: '완벽' },
];
function getConfidenceTier(confidence) {
  for (const tier of TIERS) {
    if (confidence >= tier.min && confidence < tier.max) return tier;
  }
  return TIERS[TIERS.length - 1];
}

// ── Test harness ──────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function assert(label, cond) {
  if (cond) { console.log(`  ✓  ${label}`); pass++; }
  else       { console.error(`  ✗  ${label}`); fail++; }
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n[1] validateMlOutput — schema validation');

const r1 = validateMlOutput({ shape: 'circle', confidence: undefined });
assert('undefined → NaN', isNaN(r1.confidence));

const r2 = validateMlOutput({ shape: 'circle', confidence: null });
assert('null → NaN (Number(null)===0 bug blocked)', isNaN(r2.confidence) && r2.confidence !== 0);

const r3 = validateMlOutput({ shape: 'circle', confidence: '0.8' });
assert('string "0.8" → NaN', isNaN(r3.confidence));

const r4 = validateMlOutput({ shape: 'circle', confidence: NaN });
assert('explicit NaN → NaN', isNaN(r4.confidence));

const r5 = validateMlOutput({ shape: 'circle', confidence: Infinity });
assert('Infinity → NaN', isNaN(r5.confidence));

const r6 = validateMlOutput({ shape: 'circle', confidence: -Infinity });
assert('-Infinity → NaN', isNaN(r6.confidence));

const r7 = validateMlOutput({ shape: 'circle', confidence: 0.72 });
assert('valid 0.72 preserved', r7.confidence === 0.72);

const r8 = validateMlOutput({ shape: 'circle', confidence: 0.0 });
assert('0.0 (finite) preserved — not NaN', r8.confidence === 0.0 && !isNaN(r8.confidence));

const r9 = validateMlOutput(null);
assert('null input → NaN', isNaN(r9.confidence));

const r10 = validateMlOutput(undefined);
assert('undefined input → NaN', isNaN(r10.confidence));

const r11 = validateMlOutput({ shape: null, confidence: 0.5 });
assert('null shape → null', r11.shape === null);

const r12 = validateMlOutput({ shape: 42, confidence: 0.5 });
assert('numeric shape → null', r12.shape === null);

const r13 = validateMlOutput({ shape: 'circle', confidence: '0.9' });
assert('string confidence: shape still preserved', r13.shape === 'circle' && isNaN(r13.confidence));

// ────────────────────────────────────────────────────────────────────────────
console.log('\n[2] getConfidenceTier — 7 QA boundary points');

const qa = [
  [0.39, '실패', 0.0],
  [0.40, '약화', 0.7],
  [0.59, '약화', 0.7],
  [0.60, '약화', 0.7],   // critical: was "정상" in old schema
  [0.64, '약화', 0.7],   // critical: was "정상" in old schema
  [0.65, '정상', 1.0],   // critical: 0.65 경계
  [0.80, '완벽', 1.3],
];

for (const [conf, expectLabel, expectMult] of qa) {
  const t = getConfidenceTier(conf);
  assert(
    `conf=${conf} → label="${expectLabel}" damageMult=${expectMult}`,
    t.label === expectLabel && t.damageMult === expectMult
  );
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n[3] 0.40~0.64 구간 서버 통과(damageMult>0) + 약화 표시');

for (const conf of [0.40, 0.50, 0.59, 0.60, 0.64]) {
  const t = getConfidenceTier(conf);
  assert(
    `conf=${conf}: 통과(damageMult>0) AND 약화 레이블`,
    t.damageMult > 0 && t.label === '약화'
  );
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n[4] 실패 구간 차단(damageMult===0)');

for (const conf of [0.0, 0.20, 0.39]) {
  const t = getConfidenceTier(conf);
  assert(`conf=${conf}: 차단(damageMult===0)`, t.damageMult === 0.0);
}

// ────────────────────────────────────────────────────────────────────────────
console.log(`\n── Results: ${pass} passed, ${fail} failed`);
if (fail > 0) console.error('\n일부 테스트 실패!');
process.exit(fail > 0 ? 1 : 0);
