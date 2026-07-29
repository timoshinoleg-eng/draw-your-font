'use strict';
// MAX-quality track: img2bez (cubic bezier) -> UFO -> fonttools (CFF + GSUB).
//
// This is the premium counterpart to the base potrace/svg2ttf path. It keeps
// draw-your-font's robust binarization + segmentation (the front of the
// pipeline) but swaps the geometry core for two free, industry-grade engines:
//
//   img2bez  -> traces each crop to cubic bezier contours, detects structure
//               (extrema, corners, inflections), G2-harmonizes, and writes
//               directly into a UFO font source with correct metrics.
//   fonttools-> compiles the UFO into a binary font (OTF/CFF or TTF/glyf),
//               optionally with a .fea feature file that adds GSUB (calt for
//               the "live" handwriting font) and GPOS (kerning).
//
// Everything stays local and free (Apache/MIT). No FontForge, no Glyphs.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { band } = require('./metrics');

const PY = process.env.DYF_PYTHON || 'python';
const HERE = path.dirname(__filename);
const ASSEMBLE_CFF = path.join(HERE, 'py', 'assemble_cff.py');

// Resolve the img2bez binary once: $DYF_IMG2BEZ, else next to its source repo,
// else on PATH (cargo install). We probe rather than assume.
function resolveImg2bez() {
  if (process.env.DYF_IMG2BEZ && fs.existsSync(process.env.DYF_IMG2BEZ)) {
    return process.env.DYF_IMG2BEZ;
  }
  const repoBin = path.join(HERE, '..', '..', 'img2bez', 'target', 'release', 'img2bez.exe');
  if (fs.existsSync(repoBin)) return repoBin;
  const repoBinUnix = path.join(HERE, '..', '..', 'img2bez', 'target', 'release', 'img2bez');
  if (fs.existsSync(repoBinUnix)) return repoBinUnix;
  try {
    execFileSync('img2bez', ['--version'], { stdio: 'ignore' });
    return 'img2bez';
  } catch {
    throw new Error(
      'img2bez not found. Build it (cargo build --release in the img2bez repo) ' +
      'or install it (cargo install --git https://github.com/eliheuer/img2bez), ' +
      'then set DYF_IMG2BEZ to its path.'
    );
  }
}

/**
 * Trace all labeled crops into a single UFO via img2bez.
 *
 * @param {string} dir workdir containing blobs.json + crops/
 * @param {Object.<string,string>} labels blob id -> character
 * @param {{pad:number}} blobsManifest from blobs.json (pad used when cropping)
 * @param {string} ufoDir target .ufo path (created)
 * @param {{variants?: Object, weight?: number, smooth?: number, name?: string}} opts
 *        variants[char] -> array of crop paths; weight -2..2 (dilate/erode);
 *        smooth 0..2 (img2bez accuracy/blur); name = font family name.
 * @returns {{glyphCount:number, variants: Object}} summary
 */
async function traceToUFO(dir, labels, blobsManifest, ufoDir, opts = {}) {
  const img2bez = resolveImg2bez();
  const pad = blobsManifest.pad || 8;
  const blobs = blobsManifest.blobs;
  const seen = new Set();
  let count = 0;

  // img2bez writes a 1024-UPM UFO by default (norad convention). draw-your-font's
  // metrics.band() values are authored for a 1000-UPM em square (metrics.js UPM).
  // Scale the fit-y band so the glyph lands in the same *relative* position:
  // a cap-height band of [0,700] becomes [0,716.8] in 1024 space, so the final
  // font's cap height reads as 700 once normalized back to 1000. Without this,
  // bands were silently interpreted in 1024 space, shifting every glyph ~2.4%.
  const scale = UPM_DST / UPM_SRC;

  // weight: -2..2. img2bez has no stroke-weight flag, so we apply morphological
  // dilate/erode to the crop PNG first (the same adjustWeight the base track
  // uses), then trace the adjusted image. +weight thicker, -weight thinner.
  const weight = clampWeight(opts.weight);
  const { adjustWeight } = require('./trace');

  // smooth: 0..2 maps to img2bez accuracy (higher smooth = looser fit, fewer/
  // rounder points) + a small pre-blur to soften phone-photo edge texture.
  const smooth = clampSmooth(opts.smooth);
  const { accuracy, preBlur, mode } = smoothToImg2bez(smooth);

  // Helper: run img2bez on a (possibly weight-adjusted) image buffer/path.
  const traceOne = (cropPath, glyphName, withUnicode, baseArgs) => {
    const args = [...baseArgs, '--name', glyphName];
    if (withUnicode) args.push('--unicode', withUnicode);
    execFileSync(img2bez, args, { stdio: 'pipe' });
  };

  for (const blob of blobs) {
    let char = labels[blob.id];
    if (!char) continue;
    char = char.normalize('NFC');
    if ([...char].length > 1) continue; // multi-char not supported yet
    if (seen.has(char)) continue;
    seen.add(char);
    const cropPath = path.resolve(path.join(dir, blob.crop));
    if (!fs.existsSync(cropPath)) continue;

    // Apply weight adjustment if requested (writes a temp PNG, traced instead).
    // Unique path per blob so concurrent builds don't collide, and cleaned in
    // finally so a mid-run img2bez crash never leaks the temp file.
    let inputPath = cropPath;
    const tmpPath = path.join(require('os').tmpdir(), `dyf-weight-${process.pid}-${blob.id}.png`);
    if (weight) {
      let png = fs.readFileSync(cropPath);
      png = await adjustWeight(png, weight);
      fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
      fs.writeFileSync(tmpPath, png);
      inputPath = tmpPath;
    }
    try {
      // Map the draw-your-font vertical band into img2bez's 1024-UPM space.
      const [ymin, ymax] = scaleBand(band(char), scale);
      const cp = char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
      const glyphName = 'uni' + cp;

      const baseArgs = [
        '--input', inputPath,
        '--output', ufoDir,
        '--fit-source', 'ink',
        '--fit-y', `${ymin}:${ymax}`,
        '--profile', 'photo',
        '--grid', '2',
        '--mode', mode,
        '--accuracy', String(accuracy),
        '--lsb', String(Math.round(50 * scale)),
        '--rsb', String(Math.round(50 * scale)),
      ];
      if (preBlur) baseArgs.push('--pre-blur', String(preBlur));

      traceOne(inputPath, glyphName, cp, baseArgs);
      count++;

      // Phase 2: variant glyphs (live-font). Trace extra crops for the same
      // character as named alternates; assemble_cff later wires them into calt.
      const variants = opts.variants && opts.variants[char];
      if (variants) {
        variants.forEach((vCropRel, vi) => {
          const vCrop = path.isAbsolute(vCropRel) ? vCropRel : path.resolve(path.join(dir, vCropRel));
          if (!fs.existsSync(vCrop)) return;
          const vArgs = [...baseArgs];
          vArgs[vArgs.indexOf('--input') + 1] = vCrop;
          traceOne(vCrop, `${glyphName}.alt${vi + 1}`, null, vArgs);
        });
      }
    } finally {
      // Always clean up the per-blob temp weight image, even on error.
      if (weight && fs.existsSync(tmpPath)) fs.rmSync(tmpPath);
    }
  }

  // Set the family name in the UFO (img2bez defaults it to "font").
  if (opts.name) setUfoFamily(ufoDir, opts.name);

  return { glyphCount: count };
}

// Patch fontinfo.plist so the compiled font carries the user's family name
// instead of img2bez's default "font".
function setUfoFamily(ufoDir, name) {
  const p = path.join(ufoDir, 'fontinfo.plist');
  if (!fs.existsSync(p)) return;
  let txt = fs.readFileSync(p, 'utf8');
  txt = txt.replace(/<key>familyName<\/key>\s*<string>[^<]*<\/string>/,
    `<key>familyName</key>\n\t<string>${name.replace(/[<>&]/g, '')}</string>`);
  fs.writeFileSync(p, txt);
}

// --- pure, unit-testable helpers (no fs, no img2bez) ------------------------
// These factor the arithmetic out of traceToUFO so the UPM scaling and the
// weight/smooth clamps can be pinned by unit tests without running the full
// (slow, dependency-heavy) max pipeline.

// draw-your-font's metrics.band() values are authored for 1000-UPM; img2bez
// writes a 1024-UPM UFO (norad convention). Bands must be scaled so a glyph
// that should sit at cap-height 700 (in 1000 space) is placed at 716.8 in the
// 1024-UPM source and reads back as 700 once normalized.
const UPM_SRC = 1000;
const UPM_DST = 1024;

/** Clamp the --weight flag to its supported range (-2..2); NaN/undefined -> 0. */
function clampWeight(w) {
  return Math.max(-2, Math.min(2, Number(w) || 0));
}

/** Clamp the --smooth flag to its supported range (0..2); NaN/undefined -> 1. */
function clampSmooth(s) {
  return Math.max(0, Math.min(2, Number(s) === 0 ? 0 : (Number(s) || 1)));
}

/**
 * Map a --smooth value (0..2) to img2bez tuning: fit accuracy, optional
 * pre-blur, and the output-shape mode. Pure function — keeps the mapping in
 * one place so the test can pin it.
 *
 * @param {number} smooth 0..2
 * @returns {{accuracy:number, preBlur:number, mode:'smooth'|'default'}}
 */
function smoothToImg2bez(smooth) {
  const s = clampSmooth(smooth);
  return {
    accuracy: 1.5 + s * 0.6,       // higher smooth = looser fit, rounder points
    preBlur: s >= 1.5 ? 1.0 : 0,   // soften phone-photo edge texture past 1.5
    mode: s >= 0.5 ? 'smooth' : 'default',
  };
}

/**
 * Scale a metrics.js vertical band [bottom, top] (in 1000-UPM) into the
 * destination UPM space, rounded for stable output. Pure and deterministic.
 *
 * @param {[number,number]} band1000 [bottom, top] in 1000-UPM font units
 * @param {number} [scale] destination/src UPM ratio (default 1024/1000)
 * @returns {[number,number]} [ymin, ymax] in destination-UPM font units
 */
function scaleBand(band1000, scale = UPM_DST / UPM_SRC) {
  return band1000.map((v) => Math.round(v * scale));
}

/**
 * Compile the UFO to final font binaries via fonttools/ufo2ft.
 *
 * @param {string} ufoDir
 * @param {string} familyName
 * @param {string} outBase  e.g. 'work/DansHand'
 * @param {string[]} formats ['otf','woff','woff2','ttf']
 * @param {string} [feaPath] optional .fea (GSUB calt / liga / kern)
 * @returns {{written:string[], glyphCount:number, hasGSUB:boolean, hasCFF:boolean}}
 */
function compileFont(ufoDir, familyName, outBase, formats, feaPath) {
  fs.mkdirSync(path.dirname(path.resolve(outBase)), { recursive: true });
  const args = [ASSEMBLE_CFF];
  if (feaPath) args.push('--features', path.resolve(feaPath));
  args.push(path.resolve(ufoDir), familyName, path.resolve(outBase), formats.join(','));
  const out = execFileSync(PY, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  // assemble_cff prints a JSON summary on its last stdout line.
  const lines = out.trim().split(/\r?\n/);
  const summary = JSON.parse(lines[lines.length - 1]);
  return summary;
}

module.exports = {
  traceToUFO,
  compileFont,
  resolveImg2bez,
  // pure helpers, exported for unit testing
  UPM_SRC,
  UPM_DST,
  clampWeight,
  clampSmooth,
  smoothToImg2bez,
  scaleBand,
};
