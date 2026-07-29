'use strict';
// End-to-end self-check for the "live font" (Phase 2): two photos of the same
// handwriting, where one letter appears multiple times, become a font whose
// GSUB calt feature cycles real alternates so repeated letters differ.
//
// This is the project's headline feature: authentic handwriting variation
// (real re-drawn variants), not synthetic jitter noise, delivered via calt
// (broad browser support) rather than rand (InDesign-only).
//
// Requires the max-track prerequisites (img2bez + Python/fonttools). Run:
//   node test/e2e-live.js
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, 'tmp-live');
const WORK = path.join(TMP, 'work');
const IMG2BEZ =
  process.env.DYF_IMG2BEZ ||
  path.join(ROOT, '..', 'img2bez', 'target', 'release', 'img2bez') +
    (process.platform === 'win32' ? '.exe' : '');

// fontTools is needed to inspect the GSUB table (opentype.js can't read GSUB).
let PYTHON = process.env.DYF_PYTHON || 'python';
try {
  execSync(`${PYTHON} -c "import fontTools, ufo2ft, ufoLib2"`, { stdio: 'ignore' });
} catch {
  console.error('e2e-live SKIPPED: needs Python with fonttools/ufo2ft/ufoLib2');
  process.exit(0);
}

if (!fs.existsSync(IMG2BEZ)) {
  console.error(`e2e-live SKIPPED: img2bez binary not found at ${IMG2BEZ}`);
  process.exit(0);
}

// Build two photos of the SAME letters at slightly different positions/rotations,
// so segmenting each yields the same alphabet but genuinely different ink.
// We then tell the build that photo 2 provides variant crops for the letters
// that photo 1 already covered.
const LETTERS = {
  A: 'M15,130 L50,15 L85,130 M30,92 L70,88',
  o: 'M50,70 C25,70 20,95 25,112 C32,132 68,132 75,112 C80,95 75,70 50,70',
};

async function makePhoto(file, rot, dx, dy) {
  const place = (char, x, y, r) =>
    `<g transform="translate(${x},${y}) rotate(${r})"><path d="${LETTERS[char]}" fill="none" stroke="#1c1c22" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/></g>`;
  const svg = `<svg width="900" height="340" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#f2eee6"/>
    ${place('A', 80 + dx, 30 + dy, rot)}${place('o', 320 + dx, 30 + dy, rot + 2)}
  </svg>`;
  await require('sharp')(Buffer.from(svg), { density: 144 }).jpeg({ quality: 88 }).toFile(file);
}

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const photo1 = path.join(TMP, 'sample1.jpg');
  const photo2 = path.join(TMP, 'sample2.jpg');
  await makePhoto(photo1, -2, 0, 0);
  await makePhoto(photo2, 3, 10, 8); // same letters, redrawn offset/rotated

  // Segment both photos into one workdir. blob ids run 0..3 across both.
  execFileSync(process.execPath,
    [path.join(ROOT, 'src/cli.js'), 'segment', photo1, photo2, '-d', WORK],
    { encoding: 'utf8', env: { ...process.env, DYF_IMG2BEZ: IMG2BEZ } });

  const blobs = JSON.parse(fs.readFileSync(path.join(WORK, 'blobs.json'), 'utf8'));
  // Reading order: photo1 A(0) o(1), photo2 A(2) o(3).
  assert.equal(blobs.blobs.length, 4, 'two photos of Ao should yield 4 blobs');
  const labels = { '0': 'A', '1': 'o', '2': 'A', '3': 'o' };
  fs.writeFileSync(path.join(WORK, 'labels.json'), JSON.stringify(labels));

  // The "live" variant map: A and o each have one extra crop (from photo 2).
  // crop paths in blobs.json are relative to the workdir.
  const variants = {
    A: [blobs.blobs[2].crop],
    o: [blobs.blobs[3].crop],
  };
  fs.writeFileSync(path.join(WORK, 'variants.json'), JSON.stringify(variants));

  // Build the live font via the max track. The duplicate labels (A twice) are
  // resolved by the base path keeping the first; the second becomes an alt.
  const out = execFileSync(process.execPath,
    [path.join(ROOT, 'src/cli.js'), 'build', '-d', WORK,
     '--labels', path.join(WORK, 'labels.json'), '--name', 'Live Test',
     '--quality', 'max', '--variants', path.join(WORK, 'variants.json'),
     '--formats', 'otf'],
    { encoding: 'utf8', env: { ...process.env, DYF_IMG2BEZ: IMG2BEZ } });
  console.log(out);

  assert.match(out, /Live font: cycling/, 'the build should report a live-font calt cycle');
  assert.match(out, /GSUB/, 'output should mention GSUB');

  // Inspect the compiled OTF: it MUST carry a GSUB table with a calt feature.
  const otf = path.join(WORK, 'LiveTest.otf');
  assert.ok(fs.existsSync(otf), 'OTF produced');
  const inspect = execSync(
    `${PYTHON} -c "import json; from fontTools.ttLib import TTFont; f=TTFont(r'${otf.replace(/\\/g,'/')}'); g=f['GSUB'].table; tags=[fe.FeatureTag for fe in g.FeatureList.FeatureRecord]; print(json.dumps({'hasGSUB': 'GSUB' in f, 'features': tags, 'lookups': len(g.LookupList.Lookup) if g.LookupList else 0, 'glyphs': len(f.getGlyphOrder())}))"`,
    { encoding: 'utf8' }
  );
  const info = JSON.parse(inspect.trim());
  console.log('GSUB inspection (manual path):', info);
  assert.equal(info.hasGSUB, true, 'GSUB table present');
  assert.ok(info.features.includes('calt'), 'calt feature present');
  assert.ok(info.lookups >= 2, 'at least the alt lookups exist');

  // --- Part 2: the one-liner auto-variant path (no labels/variants files) ---
  // The headline UX: two photos + --chars is all the user types. Duplicates
  // across photos auto-promote to variants, calt is generated, no manual JSON.
  const autoDir = path.join(TMP, 'auto');
  const autoOut = execFileSync(process.execPath,
    [path.join(ROOT, 'src/cli.js'), 'make', photo1, photo2, '--chars', 'Ao',
     '-d', autoDir, '--name', 'Auto Live', '--quality', 'max', '--formats', 'otf'],
    { encoding: 'utf8', env: { ...process.env, DYF_IMG2BEZ: IMG2BEZ } });
  console.log(autoOut);
  assert.match(autoOut, /auto-promoted to live-font variants/, 'auto-variant detection ran');
  assert.match(autoOut, /calt/);

  const autoOtf = path.join(autoDir, 'AutoLive.otf');
  const autoInspect = execSync(
    `${PYTHON} -c "import json; from fontTools.ttLib import TTFont; f=TTFont(r'${autoOtf.replace(/\\/g,'/')}'); g=f['GSUB'].table; tags=[fe.FeatureTag for fe in g.FeatureList.FeatureRecord]; print(json.dumps({'hasGSUB': 'GSUB' in f, 'features': tags}))"`,
    { encoding: 'utf8' }
  );
  const autoInfo = JSON.parse(autoInspect.trim());
  console.log('GSUB inspection (auto path):', autoInfo);
  assert.equal(autoInfo.hasGSUB, true, 'one-liner also produces GSUB');
  assert.ok(autoInfo.features.includes('calt'), 'one-liner also has calt');

  console.log('e2e-live OK - manual and one-liner paths both yield a live font with calt.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
