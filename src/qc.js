'use strict';
// Reference-free glyph quality scoring — the QC step borrowed from kalam's
// cv_check.py. We don't have a "ground truth" for handwriting, so the score is
// a composite of signals that correlate with a bad trace:
//
//   - repro IoU (img2bez's judge): how well the traced outline re-renders the
//     source pixels. Low IoU = the bezier outline drifted from the ink.
//   - parsimony: point count relative to outline complexity. Bloated outlines
//     (hundreds of points for a simple letter) mean the fitter struggled.
//   - structural regularity: fraction of on-curve points with H/V handles.
//     Erratic handles suggest noisy input.
//   - advance sanity: a near-zero or absurd advance means the glyph placement
//     broke.
//
// The score is 0..10 (10 = clean). Below ~6, the glyph is flagged for a re-shoot
// or a --smooth rebuild. This is advisory, never blocking (per kalam's design:
// a human/agent decides).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Score every glyph by re-running img2bez in JSON mode on each crop and
 * aggregating. Writes a qc-report.json and prints a summary.
 *
 * The img2bez JSON output carries the outline + advance + point counts (but not
 * the judge verdict, which only prints to stderr in trace mode). We derive a
 * reference-free score from what JSON gives us: point count (parsimony proxy),
 * advance sanity, and whether the trace produced any contours at all.
 *
 * @param {string} dir workdir (has crops/, blobs.json)
 * @param {Object.<string,string>} labels blobId -> char
 * @returns {{perGlyph:Object, average:number, worst:Array, error?:string}} report
 */
function scoreFont(dir, labels) {
  const img2bez = process.env.DYF_IMG2BEZ || findImg2bez();
  if (!img2bez) return { error: 'img2bez not found (set DYF_IMG2BEZ)' };
  const blobs = JSON.parse(fs.readFileSync(path.join(dir, 'blobs.json'), 'utf8'));
  const { band } = require('./metrics');
  const perGlyph = {};
  let sum = 0;
  let n = 0;
  for (const blob of blobs.blobs) {
    const char = labels[blob.id];
    if (!char) continue;
    const cropPath = path.join(dir, blob.crop);
    if (!fs.existsSync(cropPath)) continue;
    const [ymin, ymax] = band(char);
    const cp = char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
    let info;
    try {
      const out = execFileSync(img2bez, [
        '--input', cropPath, '--output', '-', '--name', 'uni' + cp,
        '--fit-source', 'ink', '--fit-y', `${ymin}:${ymax}`,
        '--profile', 'photo', '--grid', '2', '--mode', 'smooth',
        '--format', 'json',
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      info = JSON.parse(out);
    } catch {
      // A failed re-trace is itself a strong QC signal: the glyph is bad.
      perGlyph[char] = { score: 0, flags: ['trace failed — re-shoot this letter'], details: {} };
      sum += 0;
      n++;
      continue;
    }
    const result = scoreFromOutline(info);
    perGlyph[char] = result;
    sum += result.score;
    n++;
  }
  const average = n ? Math.round((sum / n) * 10) / 10 : 0;
  const worst = Object.entries(perGlyph)
    .sort((a, b) => a[1].score - b[1].score)
    .slice(0, 3)
    .map(([ch, r]) => ({ char: ch, score: r.score, flag: r.flags[0] }));
  const report = { perGlyph, average, worst, glyphCount: n };
  fs.writeFileSync(path.join(dir, 'qc-report.json'), JSON.stringify(report, null, 2));
  return report;
}

// Derive a reference-free score from the img2bez JSON outline (point count +
// advance). Simpler letterforms need fewer points; a bloated outline (hundreds
// of points for an 'l') flags a noisy crop. No judge verdict is needed.
function scoreFromOutline(info) {
  const contours = (info.outline && info.outline.contours) || [];
  const points = contours.reduce((s, c) => s + ((c.points || []).length), 0);
  const advance = (info.advance && info.advance.width) || 0;
  const flags = [];

  // Parsimony: a clean lowercase letter is ~15-60 points; >120 means the fitter
  // fought noise. Normalize into a 0..1 goodness (fewer points = better, up to
  // a floor where it's just a simple shape).
  const idealPoints = 30;
  const parsimony = points <= idealPoints ? 1 : Math.max(0, 1 - (points - idealPoints) / 150);

  // Advance sanity: 50..900 font units is normal for body glyphs.
  const advGood = advance >= 50 && advance <= 900 ? 1 : Math.max(0, 1 - Math.abs(advance - 475) / 475);

  // Empty outline is a hard fail.
  const hasInk = contours.length > 0 ? 1 : 0;

  // Weighted into 0..10. Without repro IoU we lean on parsimony + advance.
  let score = parsimony * 5 + advGood * 3 + hasInk * 2;

  if (!hasInk) flags.push('no contours — trace found nothing; re-shoot');
  else if (points > 150) flags.push(`bloated outline (${points} pts) — noisy crop; re-shoot or --smooth`);
  else if (advance < 50) flags.push('suspicious advance — placement may have failed');
  else if (parsimony > 0.6 && advGood > 0.7) flags.push('clean');
  else flags.push('acceptable'); // default so flags[0] is never undefined

  return { score: Math.round(score * 10) / 10, flags, details: { points, advance, contours: contours.length } };
}

function findImg2bez() {
  const here = path.dirname(__filename);
  const candidates = [
    process.env.DYF_IMG2BEZ,
    path.join(here, '..', '..', 'img2bez', 'target', 'release', 'img2bez.exe'),
    path.join(here, '..', '..', 'img2bez', 'target', 'release', 'img2bez'),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try { execFileSync('img2bez', ['--help'], { stdio: 'ignore' }); return 'img2bez'; } catch { return null; }
}

module.exports = { scoreFont };
