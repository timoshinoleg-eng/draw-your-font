'use strict';
// Hungarian-algorithm assignment for auto-labeling segmented glyphs.
//
// When the user knows the alphabet they wrote but not which blob is which
// letter, we score each (glyph, candidate-letter) pair and find the globally
// optimal one-to-one assignment. Borrowed from HandFonted, which used
// scipy.linear_sum_assignment — the same Hungarian algorithm, here in pure JS
// so the CLI stays zero-dependency (no numpy/python at this stage).
//
// The cost matrix is [glyph_i][letter_j]; the algorithm minimizes total cost.
// Cost here is a dissimilarity between a glyph crop's features (aspect ratio,
// ink density, height ratio vs the median) and a letter's expected features.
// Without a trained model the "expected" features are coarse heuristics, so
// this is a *fallback* when an agent/human can't label — not the primary path.
// The primary path remains AI vision (draw-your-font's skill) or a template
// (where order is known by construction).

/**
 * Solve the assignment problem on a cost matrix via the Hungarian algorithm
 * (Kuhn-Munkres, O(n^3)). Returns an array of [row, col] pairs giving the
 * minimum-cost one-to-one matching.
 *
 * @param {number[][]} cost matrix [rows][cols]; need not be square (the smaller
 *        dimension determines how many assignments are made).
 * @returns {Array<[number,number]>} assigned [row, col] pairs
 */
function hungarian(cost) {
  const rows = cost.length;
  if (rows === 0) return [];
  const cols = cost[0].length;
  // Pad to square by adding dummy rows/cols with a large cost; trim later.
  const n = Math.max(rows, cols);
  const BIG = 1e9;
  const a = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i < rows && j < cols ? cost[i][j] : BIG))
  );

  // Standard O(n^3) implementation (potentials + augmenting paths).
  const INF = BigInt(Number.MAX_SAFE_INTEGER);
  const u = new Array(n + 1).fill(0);
  const v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0); // p[j] = row assigned to col j
  const way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(INF);
    const used = new Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = -1;
      for (let j = 1; j <= n; j++) {
        if (!used[j]) {
          const cur = BigInt(Math.round(a[i0 - 1][j - 1])) - BigInt(u[i0]) - BigInt(v[j]);
          if (cur < minv[j]) {
            minv[j] = cur;
            way[j] = j0;
          }
          if (minv[j] < delta) {
            delta = minv[j];
            j1 = j;
          }
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += Number(delta);
          v[j] -= Number(delta);
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  // Recover assignments, dropping dummy rows/cols.
  const result = [];
  for (let j = 1; j <= n; j++) {
    const i = p[j];
    if (i <= rows && j <= cols) result.push([i - 1, j - 1]);
  }
  return result;
}

// --- glyph feature extraction (the cost matrix source) ----------------------

/**
 * Extract simple, model-free features from a crop's bounding box + ink.
 * Used to build the cost matrix for auto-assignment. These are deliberately
 * coarse: aspect ratio and ink-density discriminate broad classes (tall i vs
 * wide m, hollow o vs solid blob) but cannot match subtle letter shapes —
 * that needs vision, which is the primary labeling path.
 *
 * @param {{box:{x0,y0,x1,y1}, area:number}} blob from blobs.json
 * @returns {{aspect:number, heightRatio:number}} features in [0,1]-ish range
 */
function glyphFeatures(blob) {
  const w = blob.box.x1 - blob.box.x0 + 1;
  const h = blob.box.y1 - blob.box.y0 + 1;
  const aspect = w / Math.max(1, h); // wide vs tall
  const fill = blob.area / Math.max(1, w * h); // ink density
  return { aspect, fill };
}

/**
 * Build a cost matrix for assigning blobs to a known list of characters.
 *
 * @param {Array} blobs blobs.json blobs (with box + area)
 * @param {string[]} chars the characters, in expected reading order
 * @param {number} medianHeight median glyph height (for height-ratio features)
 * @returns {number[][]} cost[blobIndex][charIndex]
 */
function buildCostMatrix(blobs, chars, medianHeight) {
  const features = blobs.map(glyphFeatures);
  return features.map((f, i) =>
    chars.map((ch, j) => {
      const h = blobs[i].box.y1 - blobs[i].box.y0 + 1;
      const heightRatio = h / Math.max(1, medianHeight);
      const expected = expectedFeatures(ch, medianHeight);
      // Squared feature distance; position-order is a tie-breaker (reading
      // order usually tracks the charset order, lightly weighted so it never
      // overrides a strong shape signal).
      const shape =
        Math.pow(f.aspect - expected.aspect, 2) +
        Math.pow(f.fill - expected.fill, 2) +
        Math.pow(heightRatio - expected.heightRatio, 2);
      const orderPenalty = Math.pow((i - j) / Math.max(1, chars.length), 2) * 0.3;
      return shape + orderPenalty;
    })
  );
}

// Coarse priors: which letters tend to be tall/short, hollow/solid, wide/narrow.
// Ranges are loose; this only needs to be better than random for a fallback.
const TALL = new Set('bdfhklABDEFHIKLMNPRt'); // ascenders/caps
const SHORT = new Set('acemnorsuvwxz'); // x-height
const DESC = new Set('gjpqy'); // descenders
const WIDE = new Set('mwMW'); // wide
const NARROW = new Set('il1Irjt'); // narrow
const HOLLOW = new Set('oOaAbpDQeR0469'); // likely enclosed counters

function expectedFeatures(ch, medianHeight) {
  let heightRatio = 1.0; // x-height by default
  if (TALL.has(ch)) heightRatio = 1.5;
  else if (DESC.has(ch)) heightRatio = 1.7; // descenders span more vertical
  else if (SHORT.has(ch)) heightRatio = 1.0;
  let aspect = 0.7;
  if (WIDE.has(ch)) aspect = 1.3;
  else if (NARROW.has(ch)) aspect = 0.4;
  const fill = HOLLOW.has(ch) ? 0.35 : 0.5;
  return { aspect, fill, heightRatio };
}

/**
 * Auto-assign blobs to characters using the Hungarian algorithm on shape
 * features. Returns a labels map {blobId: char}, like the manual labels.json.
 *
 * @param {{blobs:Array, pad:number}} blobsManifest
 * @param {string[]} chars expected characters (reading order)
 * @returns {Object.<string,string>} blobId -> character
 */
function autoLabel(blobsManifest, chars) {
  const blobs = blobsManifest.blobs;
  const heights = blobs.map((b) => b.box.y1 - b.box.y0 + 1).filter((h) => h >= 8);
  heights.sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 50;
  const n = Math.min(blobs.length, chars.length);
  const cost = buildCostMatrix(blobs.slice(0, n), chars.slice(0, n), medianHeight);
  const assignment = hungarian(cost);
  const labels = {};
  for (const [bi, ci] of assignment) labels[blobs[bi].id] = chars[ci];
  return labels;
}

module.exports = { hungarian, autoLabel, buildCostMatrix, glyphFeatures };
