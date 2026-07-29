'use strict';
// End-to-end self-check for Cyrillic support: a synthetic photo of Russian
// handwriting → segment → trace → font, validated by parsing the font back and
// asserting the height-class bands are applied to every glyph.
//
// Cyrillic is a core promise of this project — it is the only open-source
// handwriting-photo-to-font tool that supports Russian (verified: yashlamba/
// handwrite and all 51 forks are Latin-only). This test pins that promise so a
// future refactor of metrics.js or charsets.js can't silently regress it.
//
// Covers BOTH tracks: base (potrace → TTF) and max (img2bez → OTF/CFF).
// The max track needs img2bez + Python/fonttools; if absent it self-skips.
// Run: node test/e2e-cyrillic.js
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const opentype = require('opentype.js');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, 'tmp-cyr');
const IMG2BEZ =
  process.env.DYF_IMG2BEZ ||
  path.join(ROOT, '..', 'img2bez', 'target', 'release', 'img2bez') +
    (process.platform === 'win32' ? '.exe' : '');

// Five Russian letters, one per height class — the bands in metrics.js must map
// each to its correct vertical zone, or lowercase letters render too tall and
// descenders get cut. These are stroked SVG paths drawn to be unambiguous.
//   А — uppercase, cap height
//   а — lowercase, x-height (the critical one: default fallback made it tall)
//   р — descender, drops below baseline
//   б — ascender, rises above x-height
//   ф — tall ascender (two large bowls)
const LETTERS = {
  'А': 'M20,40 L50,140 M80,40 L50,140 M28,100 L72,100',
  'а': 'M30,110 C20,108 18,120 25,128 C40,135 60,125 55,112 M55,128 L55,140',
  'р': 'M30,80 L30,160 M30,118 C20,115 18,128 25,138 C40,145 55,135 52,125',
  'б': 'M50,40 C40,38 38,52 45,60 M50,55 C40,52 35,68 40,80 C50,90 65,80 60,70',
  'ф': 'M55,40 L55,150 M30,70 C50,60 60,90 55,110 M80,70 C60,60 50,90 55,110',
};

async function makeSamplePhoto(file) {
  const place = (char, x, y) =>
    `<g transform="translate(${x},${y})"><path d="${LETTERS[char]}" fill="none" stroke="#1c1c22" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/></g>`;
  const svg = `<svg width="900" height="300" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#f2eee6"/>
    ${place('А', 40, 30)}${place('а', 220, 40)}${place('р', 400, 40)}${place('б', 580, 30)}${place('ф', 760, 30)}
  </svg>`;
  await sharp(Buffer.from(svg), { density: 144 }).jpeg({ quality: 88 }).toFile(file);
}

// Assert the parsed font applied the right vertical band to each glyph. The
// bands are defined in metrics.js for UPM=1000; img2bez writes 1024-UPM, so we
// normalize the bbox back to 1000-space before comparing (tolerance accounts
// for the stroke width of the synthetic ink).
function assertBands(font, label, upm) {
  const k = 1000 / upm;
  const bb = (ch) => {
    const g = font.charToGlyph(ch);
    const b = g.getBoundingBox();
    return { yMin: b.y1 * k, yMax: b.y2 * k, name: g.name, advance: g.advanceWidth };
  };

  // А: uppercase at cap height [0, 700]
  let b = bb('А');
  assert.ok(b.name !== '.notdef', `[${label}] glyph for А exists`);
  assert.ok(b.yMax > 650, `[${label}] А reaches cap height (yMax=${b.yMax.toFixed(0)}, want ~700)`);

  // а: lowercase MUST stay at x-height, NOT cap height — this is the regression
  // that the old [0,CAP] fallback caused (every lowercase rendered tall).
  b = bb('а');
  assert.ok(b.name !== '.notdef', `[${label}] glyph for а exists`);
  assert.ok(b.yMax <= 520, `[${label}] а stays at x-height (yMax=${b.yMax.toFixed(0)}, want ~480, NOT cap)`);

  // р: descender drops below baseline
  b = bb('р');
  assert.ok(b.name !== '.notdef', `[${label}] glyph for р exists`);
  assert.ok(b.yMin < -150, `[${label}] р has a descender (yMin=${b.yMin.toFixed(0)}, want ~-220)`);

  // б: ascender rises above x-height
  b = bb('б');
  assert.ok(b.name !== '.notdef', `[${label}] glyph for б exists`);
  assert.ok(b.yMax > 650, `[${label}] б is ascender-tall (yMax=${b.yMax.toFixed(0)}, want ~720)`);

  // ф: tall ascender (two bowls)
  b = bb('ф');
  assert.ok(b.name !== '.notdef', `[${label}] glyph for ф exists`);
  assert.ok(b.yMax > 650, `[${label}] ф is tall (yMax=${b.yMax.toFixed(0)}, want ~720)`);
}

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const photo = path.join(TMP, 'cyrillic.jpg');
  await makeSamplePhoto(photo);

  // ---- BASE TRACK (potrace → TTF) ----------------------------------------
  const baseDir = path.join(TMP, 'base');
  const baseOut = execFileSync(
    process.execPath,
    [path.join(ROOT, 'src/cli.js'), 'make', photo, '--chars', 'Аарбф',
     '-d', baseDir, '--name', 'Cyr Base', '--formats', 'ttf'],
    { encoding: 'utf8' }
  );
  console.log(baseOut);
  assert.match(baseOut, /Found 5 glyph candidates/, 'segmentation should find 5 Cyrillic blobs');

  let raw = fs.readFileSync(path.join(baseDir, 'CyrBase.ttf'));
  let font = opentype.parse(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  assertBands(font, 'base', font.unitsPerEm);
  console.log('  base: all 5 Cyrillic height classes correct.');

  // ---- MAX TRACK (img2bez → OTF/CFF) -------------------------------------
  if (!fs.existsSync(IMG2BEZ)) {
    console.log('e2e-cyrillic PARTIAL - base OK, max skipped (img2bez not found).');
    return;
  }
  const maxDir = path.join(TMP, 'max');
  const maxOut = execFileSync(
    process.execPath,
    [path.join(ROOT, 'src/cli.js'), 'make', photo, '--chars', 'Аарбф',
     '-d', maxDir, '--name', 'Cyr Max', '--quality', 'max', '--formats', 'otf'],
    { encoding: 'utf8', env: { ...process.env, DYF_IMG2BEZ: IMG2BEZ } }
  );
  console.log(maxOut);

  raw = fs.readFileSync(path.join(maxDir, 'CyrMax.otf'));
  font = opentype.parse(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  assertBands(font, 'max', font.unitsPerEm);
  // The max track must produce cubic CFF outlines for Cyrillic too.
  assert.ok('CFF ' in font.tables || font.outlinesFormat === 'cff',
    'max track output has CFF table for Cyrillic');
  console.log('  max: all 5 Cyrillic height classes correct, CFF present.');

  console.log('e2e-cyrillic OK - Russian letters traced with correct height bands on both tracks.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
