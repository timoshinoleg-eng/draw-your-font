'use strict';
// Fast unit tests for the pure-JS modules: the Hungarian assignment, the
// calt/liga .fea generators, and the max-track arithmetic (UPM scaling +
// flag parity). These need no img2bez/python, so they run everywhere the base
// track runs. Run: node test/unit.js
const assert = require('node:assert');
const { hungarian } = require('../src/hungarian');
const { generateCalt, generateLiga, glyphName } = require('../src/livefont');
const {
  UPM_SRC, UPM_DST, clampWeight, clampSmooth, smoothToImg2bez, scaleBand,
} = require('../src/maxtrack');
const { band } = require('../src/metrics');

// --- Hungarian algorithm: classic known matrices ----------------------------

// Identity-ish matrix: minimum is the diagonal.
{
  const r = hungarian([[1, 9, 9], [9, 1, 9], [9, 9, 1]]);
  // Map to (row,col) and check it picked the diagonal (cost 3).
  const cost = r.reduce((s, [i, j]) => s + [1, 9, 9][i] && s, 0);
  const pairs = r.sort((a, b) => a[0] - b[0]).map(([i, j]) => j);
  assert.deepEqual(pairs, [0, 1, 2], 'identity-ish matrix -> diagonal assignment');
}

// The 1..9 matrix: global min is the anti-diagonal, cost 10.
{
  const m = [[1, 2, 3], [2, 4, 6], [3, 6, 9]];
  const r = hungarian(m);
  const total = r.reduce((s, [i, j]) => s + m[i][j], 0);
  assert.equal(total, 10, '1..9 matrix minimum total cost is 10');
}

// Rectangular (more rows than cols): only cols assignments come back.
{
  const m = [[1, 2], [2, 1], [5, 5]];
  const r = hungarian(m);
  assert.equal(r.length, 2, 'rectangular matrix yields min(rows,cols) pairs');
}

// 1x1 trivial.
assert.deepEqual(hungarian([[7]]), [[0, 0]], '1x1 matrix');

// Empty.
assert.deepEqual(hungarian([]), [], 'empty matrix');

// --- calt generator ----------------------------------------------------------
// The forward-step scheme: one lookup per char maps each form to the NEXT form
// in the cycle, and a chain rule fires it when the preceding glyph is any form
// of that letter. This correctly cycles k>2 (the old "count preceding base"
// scheme collapsed k>2 to 2 forms).

{
  const { feaText, lookupCount } = generateCalt({ a: 3 });
  assert.ok(feaText.includes('feature calt'), 'calt feature block emitted');
  const uni0061 = glyphName('a');
  // one forward-step lookup: base->alt1->alt2->alt3->base (k=3 alts => 4 forms)
  assert.ok(feaText.includes(`lookup step_${uni0061}`), 'forward-step lookup per char');
  assert.ok(feaText.includes(`sub ${uni0061} by ${uni0061}.alt1;`), 'base steps to alt1');
  assert.ok(feaText.includes(`sub ${uni0061}.alt1 by ${uni0061}.alt2;`), 'alt1 steps to alt2');
  assert.ok(feaText.includes(`sub ${uni0061}.alt2 by ${uni0061}.alt3;`), 'alt2 steps to alt3');
  assert.ok(feaText.includes(`sub ${uni0061}.alt3 by ${uni0061};`), 'last alt wraps back to base');
  // the chain rule uses a glyph CLASS (all forms), not a literal base — the fix
  assert.ok(feaText.includes(`[${uni0061} ${uni0061}.alt1 ${uni0061}.alt2 ${uni0061}.alt3]`), 'class of all forms in rule');
  assert.equal(lookupCount, 1, 'one step lookup per char (not one per alt)');
}

// No alternates -> empty fea (no broken feature block).
{
  const { feaText } = generateCalt({});
  assert.equal(feaText, '', 'no alternates -> empty fea');
}

// --- liga generator ----------------------------------------------------------

{
  const fea = generateLiga({ th: 'uni0074_h' });
  assert.ok(fea.includes('feature liga'), 'liga feature block emitted');
  assert.ok(fea.includes('sub uni0074 uni0068 by uni0074_h;'), 'th ligature rule present');
}

// Non-pair or empty -> empty.
assert.equal(generateLiga({}), '', 'no ligatures -> empty fea');
assert.equal(generateLiga({ abc: 'x' }), '', 'non-pair ignored');

// --- glyphName ---------------------------------------------------------------
assert.equal(glyphName('A'), 'uni0041', 'glyphName A');
assert.equal(glyphName('a'), 'uni0061', 'glyphName a');

// --- max track: UPM scaling (pins the bug where 1000-UPM bands were silently
//     interpreted in 1024 space, shifting every glyph ~2.4%) -----------------

assert.equal(UPM_SRC, 1000, 'draw-your-font metrics authored for 1000-UPM');
assert.equal(UPM_DST, 1024, 'img2bez writes a 1024-UPM UFO (norad convention)');

// scaleBand: the canonical example from the code comment. A cap-height band of
// [0,700] in 1000-UPM must scale to ~717 in 1024-UPM so it reads back as 700
// once the compiled font is normalized.
{
  const scaled = scaleBand([0, 700]);
  assert.deepEqual(scaled, [0, 717], 'cap band [0,700] -> [0,717] in 1024-UPM');
  // Round-trip: reading 717 back in 1000-UPM lands within 1 unit of 700.
  const roundTrip = scaled[1] * (UPM_SRC / UPM_DST);
  assert.ok(Math.abs(roundTrip - 700) < 1, `round-trip cap height ~700 (got ${roundTrip.toFixed(1)})`);
}

// Descender band (e.g. g): [-220, 480] — the negative floor must scale too.
{
  const [ymin, ymax] = scaleBand(band('g'));
  const rt0 = ymin * (UPM_SRC / UPM_DST);
  const rt1 = ymax * (UPM_SRC / UPM_DST);
  assert.ok(Math.abs(rt0 - (-220)) < 1.5, `g descender round-trips ~-220 (got ${rt0.toFixed(1)})`);
  assert.ok(Math.abs(rt1 - 480) < 1.5, `g x-height round-trips ~480 (got ${rt1.toFixed(1)})`);
}

// Scaling is deterministic (same input -> same output), not random per run.
assert.deepEqual(scaleBand([0, 480]), scaleBand([0, 480]), 'scaleBand deterministic');

// scaleBand respects an explicit ratio (not just the default 1024/1000).
assert.deepEqual(scaleBand([0, 100], 2), [0, 200], 'explicit scale ratio honored');

// --- flag parity: --weight and --smooth must be honored on BOTH tracks ------
// These pins the two audit gaps (max track ignored weight; smooth was
// hardcoded). The clamps define the supported range shared by base + max.

// clampWeight: bounded to [-2, 2], missing/NaN -> 0.
assert.equal(clampWeight(1), 1, 'weight 1 passes through');
assert.equal(clampWeight(-2), -2, 'weight -2 at floor');
assert.equal(clampWeight(5), 2, 'weight clamped to +2 ceiling');
assert.equal(clampWeight(-9), -2, 'weight clamped to -2 floor');
assert.equal(clampWeight(undefined), 0, 'missing weight -> 0');
assert.equal(clampWeight('abc'), 0, 'non-numeric weight -> 0');

// clampSmooth: bounded to [0, 2], missing -> 1 (the documented default).
assert.equal(clampSmooth(1.5), 1.5, 'smooth 1.5 passes through');
assert.equal(clampSmooth(0), 0, 'smooth 0 allowed (sharpest fit)');
assert.equal(clampSmooth(2), 2, 'smooth 2 at ceiling');
assert.equal(clampSmooth(9), 2, 'smooth clamped to 2');
assert.equal(clampSmooth(undefined), 1, 'missing smooth -> default 1');
// Note: Number(0)||1 would collapse 0 to 1, but clampSmooth must keep explicit 0.
assert.equal(clampSmooth(0), 0, 'explicit smooth 0 is NOT coerced to default');

// smoothToImg2bez: the mapping from --smooth to img2bez knobs. Pins the exact
// behavior so a refactor can't silently change fit quality.
{
  const sharp = smoothToImg2bez(0);
  assert.equal(sharp.mode, 'default', 'smooth 0 -> default mode (corners + lines)');
  assert.equal(sharp.preBlur, 0, 'smooth 0 -> no pre-blur');
  assert.equal(sharp.accuracy, 1.5, 'smooth 0 -> tightest accuracy');
}
{
  const organic = smoothToImg2bez(1.5);
  assert.equal(organic.mode, 'smooth', 'smooth >=0.5 -> smooth mode (all curves)');
  assert.equal(organic.preBlur, 1.0, 'smooth >=1.5 -> edge-softening pre-blur');
  assert.ok(organic.accuracy > 1.5, 'higher smooth -> looser (rounder) accuracy');
}
// Accuracy is monotonic in smooth (smoother -> looser fit).
assert.ok(smoothToImg2bez(2).accuracy > smoothToImg2bez(0).accuracy, 'accuracy monotonic in smooth');

console.log('unit OK - hungarian + calt/liga fea + max-track UPM scaling & flag parity verified.');
