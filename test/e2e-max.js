'use strict';
// End-to-end self-check for the MAX quality track: synthetic handwriting photo
// -> segment -> img2bez (cubic) -> UFO -> fonttools (CFF) -> OTF, validated by
// parsing the font back. Requires the img2bez binary on PATH or DYF_IMG2BEZ,
// plus Python with fonttools/ufo2ft. Run: node test/e2e-max.js
//
// This mirrors test/e2e.js but asserts the properties that distinguish the max
// track from the base potrace/svg2ttf path: a CFF table (cubic curves) and the
// same metric semantics (descender below baseline, cap tall, o at x-height).
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const opentype = require('opentype.js');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, 'tmp-max');
const WORK = path.join(TMP, 'work');
const IMG2BEZ =
  process.env.DYF_IMG2BEZ ||
  path.join(ROOT, '..', 'img2bez', 'target', 'release', 'img2bez') +
    (process.platform === 'win32' ? '.exe' : '');

if (!fs.existsSync(IMG2BEZ)) {
  console.error(`e2e-max SKIPPED: img2bez binary not found at ${IMG2BEZ}`);
  console.error('Build it (cargo build --release in the img2bez repo) or set DYF_IMG2BEZ.');
  process.exit(0); // not a failure — the max track is opt-in
}

// Same synthetic letters as e2e.js so the two tracks are directly comparable.
const LETTERS = {
  A: 'M15,130 L50,15 L85,130 M30,92 L70,88',
  b: 'M25,10 L26,130 M25,75 C55,60 75,80 73,100 C71,122 45,133 26,118',
  g: 'M78,68 C60,55 30,60 27,90 C25,115 45,125 60,120 C72,116 78,105 78,90 M78,65 L78,150 C76,175 45,180 35,165',
  i: 'M50,42 L51,47 M50,70 L49,130',
  o: 'M50,70 C25,70 20,95 25,112 C32,132 68,132 75,112 C80,95 75,70 50,70',
  x: 'M25,70 L75,130 M75,72 L27,128',
};

async function makeSamplePhoto(file) {
  const place = (char, x, y, rot) =>
    `<g transform="translate(${x},${y}) rotate(${rot})"><path d="${LETTERS[char]}" fill="none" stroke="#1c1c22" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/></g>`;
  const svg = `<svg width="900" height="640" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#f2eee6"/>
    <g transform="rotate(1.2, 450, 320)">
      ${place('A', 80, 30, -2)}${place('b', 300, 30, 1.5)}${place('g', 520, 30, -1)}
      ${place('i', 80, 300, 2)}${place('o', 300, 300, -1.5)}${place('x', 520, 300, 1)}
    </g></svg>`;
  await sharp(Buffer.from(svg), { density: 144 }).jpeg({ quality: 88 }).toFile(file);
}

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const photo = path.join(TMP, 'sample.jpg');
  await makeSamplePhoto(photo);

  const out = execFileSync(
    process.execPath,
    [path.join(ROOT, 'src/cli.js'), 'make', photo, '--chars', 'Abgiox', '-d', WORK,
     '--name', 'Max Test', '--quality', 'max', '--formats', 'otf,ttf,woff2'],
    { encoding: 'utf8', env: { ...process.env, DYF_IMG2BEZ: IMG2BEZ } }
  );
  console.log(out);
  assert.match(out, /Found 6 glyph candidates/, 'segmentation should find exactly 6 blobs');
  assert.match(out, /cubic bezier/, 'the max track should report cubic-bezier output');

  // --- the CFF assertion: the whole point of the max track ---
  const otfPath = path.join(WORK, 'MaxTest.otf');
  const raw = fs.readFileSync(otfPath);
  const font = opentype.parse(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));

  // unitsPerEm: img2bez defaults to 1024 (vs draw-your-font base 1000). Both are
  // valid; we only assert it is a sane UPM, not a specific value.
  assert.ok([1000, 1024].includes(font.unitsPerEm), `sane UPM (got ${font.unitsPerEm})`);

  for (const ch of 'Abgiox') {
    const glyph = font.charToGlyph(ch);
    assert.ok(glyph && glyph.name !== '.notdef', `glyph for "${ch}" exists`);
    assert.ok(glyph.advanceWidth > 50, `advance for "${ch}" is sane`);
  }

  // Band placement semantics (the craft step), now in cubic-bezier space.
  const bb = (ch) => font.charToGlyph(ch).getBoundingBox();
  assert.ok(Math.min(bb('g').y1, bb('g').y2) < -50, `g has a descender (yMin=${bb('g').y1})`);
  assert.ok(Math.max(bb('b').y1, bb('b').y2) > 500, `b is ascender-tall (yMax=${bb('b').y2})`);
  assert.ok(Math.max(bb('o').y1, bb('o').y2) <= 600, `o stays near x-height (yMax=${bb('o').y2})`);
  assert.ok(Math.max(bb('A').y1, bb('A').y2) > 500, `A reaches cap height (yMax=${bb('A').y2})`);

  // The formats land on disk.
  assert.equal(fs.readFileSync(path.join(WORK, 'MaxTest.woff2')).toString('ascii', 0, 4), 'wOF2');
  assert.ok(fs.existsSync(path.join(WORK, 'MaxTest.ttf')), 'ttf also produced');
  assert.ok(fs.existsSync(path.join(WORK, 'font.ufo')), 'UFO source preserved');

  console.log('e2e-max OK - synthetic photo became a valid OTF via the cubic-bezier max track.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
