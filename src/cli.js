#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('node:util');

const USAGE = `draw-your-font - turn a photo of your handwriting into a real font

Usage:
  draw-your-font template [-o template.pdf] [--charset minimal|spanish|cyrillic]
  draw-your-font segment <photo...> [-d workdir] [--delta N] [--cap N]
  draw-your-font build   [-d workdir] (--labels labels.json | --chars "ABC…" | --charset name)
                         [--name "My Handwriting"] [-o font] [--smooth 0..2]
                         [--weight=-2..2] [--formats otf,ttf,woff,woff2,css]
                         [--quality base|max]
                         [--variants variants.json] [--features rules.fea]
                         (negative weight needs the = form: --weight=-1)
  draw-your-font make    <photo...> (--chars "ABC…" | --charset name) [build options]
  draw-your-font preview [-d workdir] [--text "…"] [-o preview.png]

Quality tracks:
  --quality base  potrace (quadratic) → svg2ttf → TTF. Fast, zero new deps. (default)
  --quality max   img2bez (cubic) → UFO → fonttools (CFF + GSUB) → OTF.
                  Smoother organic curves; the only track that builds a "live"
                  handwriting font (--variants + --features calt). Needs Python
                  + fonttools + the img2bez binary (DYF_IMG2BEZ env var or PATH).

Typical flows:
  1. Freeform photo, you know the order you wrote in:
       draw-your-font make photo.jpg --chars "ABCabc" --name "My Hand"
  2. Printed template (order is the charset):
       draw-your-font template -o template.pdf --charset minimal
       # print, write, photograph, then:
       draw-your-font make page1.jpg page2.jpg --charset minimal
  3. Agent-assisted (Claude labels the blobs):
       draw-your-font segment photo.jpg -d work
       # inspect work/contact-1.png, write work/labels.json {"0":"A", …}
       draw-your-font build -d work --labels work/labels.json
  4. Maximum quality (cubic bezier, OTF with CFF):
       draw-your-font make photo.jpg --chars "ABCabc" --name "My Hand" --quality max --formats otf,woff2
`;

const OPTS = {
  dir: { type: 'string', short: 'd', default: 'work' },
  out: { type: 'string', short: 'o' },
  name: { type: 'string', default: 'My Handwriting' },
  labels: { type: 'string' },
  chars: { type: 'string' },
  charset: { type: 'string' },
  smooth: { type: 'string', default: '1' },
  weight: { type: 'string', default: '0' },
  formats: { type: 'string', default: 'ttf' },
  quality: { type: 'string', default: 'base' }, // base (potrace/svg2ttf) | max (img2bez/fonttools)
  variants: { type: 'string' }, // Phase 2: JSON char -> [crop paths] for the "live" font
  features: { type: 'string' }, // path to a .fea file (GSUB/GPOS) for the max track
  text: { type: 'string' },
  delta: { type: 'string' },
  cap: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(USAGE);
    process.exit(cmd ? 0 : 1);
  }
  const { values: opt, positionals } = parseArgs({ args: rest, options: OPTS, allowPositionals: true });
  if (opt.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const dir = opt.dir;

  if (cmd === 'template') {
    const { generateTemplate } = require('./template');
    const out = opt.out || 'template.pdf';
    await generateTemplate(out, { charset: opt.charset || 'minimal' });
    console.log(`Template written to ${out}. Print it, write with a dark pen, photograph each page.`);
    return;
  }

  if (cmd === 'segment' || cmd === 'make') {
    if (!positionals.length) fail('No photos given.');
    const { segment } = require('./segment');
    const manifest = await segment(positionals, dir, {
      delta: opt.delta ? Number(opt.delta) : undefined,
      cap: opt.cap ? Number(opt.cap) : undefined,
    });
    console.log(`Found ${manifest.blobs.length} glyph candidates across ${positionals.length} photo(s).`);
    console.log(`Crops: ${dir}/crops/  Contact sheet(s): ${dir}/contact-*.png  Data: ${dir}/blobs.json`);
    if (cmd === 'segment') return;
  }

  if (cmd === 'build' || cmd === 'make') {
    await build(dir, opt);
    return;
  }

  if (cmd === 'autolabel') {
    // Fallback auto-labeling via the Hungarian algorithm on shape features,
    // for when there is no AI vision and no template (order unknown). Writes a
    // labels.json that the user should still eyeball against the contact sheet.
    const { autoLabel } = require('./hungarian');
    const { CHARSETS } = require('./charsets');
    const blobs = readJSON(path.join(dir, 'blobs.json'), 'Run segment first.');
    let chars;
    if (opt.chars) chars = [...opt.chars.normalize('NFC').replace(/\s+/g, '')];
    else if (opt.charset) {
      chars = CHARSETS[opt.charset];
      if (!chars) fail(`Unknown charset "${opt.charset}".`);
    } else fail('Provide --chars "…" or --charset <name> for auto-labeling.');
    const labels = autoLabel(blobs, chars);
    const out = opt.out || path.join(dir, 'labels.json');
    fs.writeFileSync(out, JSON.stringify(labels, null, 2));
    console.log(`Auto-labeled ${Object.keys(labels).length} glyphs → ${out}`);
    console.log('WARNING: shape-feature heuristics are coarse. Verify against the contact sheet before building.');
    return;
  }

  if (cmd === 'qc') {
    // Reference-free glyph quality scoring (kalam-style cv_check). Reads the
    // labels + crops, re-traces each in JSON mode, scores, flags the weakest.
    const { scoreFont } = require('./qc');
    const { CHARSETS } = require('./charsets');
    const blobs = readJSON(path.join(dir, 'blobs.json'), 'Run segment first.');
    const labels = resolveLabels(blobs, opt, CHARSETS);
    const report = scoreFont(dir, labels);
    if (report.error) fail(report.error);
    console.log(`QC: ${report.glyphCount} glyphs scored, average ${report.average}/10`);
    console.log('Report written to', path.join(dir, 'qc-report.json'));
    console.log('Weakest glyphs:');
    for (const w of report.worst) {
      console.log(`  ${w.char}  ${w.score}/10  — ${w.flag}`);
    }
    return;
  }

  if (cmd === 'preview') {
    const { renderPreview } = require('./preview');
    const manifest = readJSON(path.join(dir, 'manifest.json'), 'Run build first.');
    const out = opt.out || path.join(dir, 'preview.png');
    await renderPreview(manifest, out, { text: opt.text });
    console.log(`Preview: ${out}`);
    return;
  }

  fail(`Unknown command "${cmd}".\n\n${USAGE}`);
}

async function build(dir, opt) {
  // Quality track selection: the front of the pipeline (binarization +
  // segmentation, in segment.js / capture.js) is shared. Only the geometry
  // core + font assembly differ.
  //   base = potrace (quadratic) -> svg2ttf -> TTF. Fast, zero new deps.
  //   max  = img2bez (cubic) -> UFO -> fonttools (CFF + GSUB) -> OTF. Smoother
  //          organic curves, the only track that can build a "live" font.
  if (opt.quality === 'max') return buildMax(dir, opt);
  return buildBase(dir, opt);
}

// --- base track: the original draw-your-font potrace/svg2ttf pipeline -------
async function buildBase(dir, opt) {
  const { trace, adjustWeight } = require('./trace');
  const { placeGlyph } = require('./metrics');
  const { buildTTF, toWoff, toWoff2, fontFaceCSS } = require('./assemble');
  const { renderPreview, renderGlyphSheet } = require('./preview');
  const { CHARSETS } = require('./charsets');

  const blobs = readJSON(path.join(dir, 'blobs.json'), 'Run segment (or make) first.');
  const labels = resolveLabels(blobs, opt, CHARSETS);

  const smooth = Number(opt.smooth);
  const weight = Math.max(-2, Math.min(2, Number(opt.weight)));
  const glyphs = [];
  const seen = new Set();
  for (const blob of blobs.blobs) {
    let char = labels[blob.id];
    if (!char) continue;
    char = char.normalize('NFC');
    if ([...char].length > 1) {
      console.warn(`  ! "${char}" (blob ${blob.id}) is a multi-character sequence - not supported yet, skipped`);
      continue;
    }
    if (seen.has(char)) {
      console.warn(`  ! duplicate "${char}" (blob ${blob.id}) - keeping the first one`);
      continue;
    }
    seen.add(char);
    let png = fs.readFileSync(path.join(dir, blob.crop));
    png = await adjustWeight(png, weight);
    const d = await trace(png, { smooth });
    if (!d) {
      console.warn(`  ! blob ${blob.id} ("${char}") traced to nothing - skipped`);
      continue;
    }
    const placed = placeGlyph(d, blob.cropSize, blobs.pad, char);
    glyphs.push({ char, ...placed, source: blob.crop });
  }
  if (!glyphs.length) fail('No glyphs to build. Check your labels.');

  const name = opt.name;
  const base = (opt.out ? opt.out.replace(/\.\w+$/, '') : path.join(dir, name.replace(/\s+/g, '')));
  fs.mkdirSync(path.dirname(path.resolve(base)), { recursive: true });
  const ttf = buildTTF(name, glyphs);
  const formats = opt.formats.split(',').map((s) => s.trim().toLowerCase());
  const written = [];
  if (formats.includes('ttf') || opt.out) {
    fs.writeFileSync(`${base}.ttf`, ttf);
    written.push(`${base}.ttf`);
  }
  if (formats.includes('woff')) {
    fs.writeFileSync(`${base}.woff`, toWoff(ttf));
    written.push(`${base}.woff`);
  }
  if (formats.includes('woff2')) {
    fs.writeFileSync(`${base}.woff2`, await toWoff2(ttf));
    written.push(`${base}.woff2`);
  }
  if (formats.includes('css')) {
    fs.writeFileSync(`${base}.css`, fontFaceCSS(name, path.basename(base)));
    written.push(`${base}.css`);
  }

  const manifest = {
    name,
    unitsPerEm: 1000,
    smooth,
    weight,
    glyphs: Object.fromEntries(glyphs.map((g) => [g.char, { d: g.d, advance: g.advance, source: g.source }])),
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  await renderPreview(manifest, path.join(dir, 'preview.png'));
  await renderGlyphSheet(manifest, path.join(dir, 'glyphs.png'));

  console.log(`Built ${glyphs.length} glyphs → ${written.join(', ')}`);
  console.log(`Preview: ${path.join(dir, 'preview.png')}  Glyph sheet: ${path.join(dir, 'glyphs.png')}`);
  const missing = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'].filter((c) => !seen.has(c));
  if (missing.length) console.log(`Letters not in this font yet: ${missing.join(' ')}`);
}

// --- max track: img2bez (cubic) -> UFO -> fonttools (CFF + GSUB) -> OTF ------
async function buildMax(dir, opt) {
  const { traceToUFO, compileFont } = require('./maxtrack');
  const { CHARSETS } = require('./charsets');

  const blobs = readJSON(path.join(dir, 'blobs.json'), 'Run segment (or make) first.');

  // Label resolution for the max track. Two paths:
  //   - explicit --labels: use as given (manual control, no auto-variants).
  //   - --chars/--charset with more blobs than unique chars (several photos of
  //     the same alphabet): auto-promote duplicates to live-font variants, so
  //     the live font is a one-liner with no --variants file.
  let labels, variants = null;
  if (opt.labels) {
    labels = resolveLabels(blobs, opt, CHARSETS);
  } else {
    const r = resolveLabelsAndVariants(blobs, opt, CHARSETS);
    labels = r.labels;
    if (Object.keys(r.autoVariants).length) variants = r.autoVariants;
  }

  // An explicit --variants file overrides auto-detected variants.
  if (opt.variants) {
    try {
      variants = JSON.parse(fs.readFileSync(opt.variants, 'utf8'));
    } catch (e) {
      fail(`Could not read --variants file: ${e.message}`);
    }
  }

  const ufoDir = path.join(dir, 'font.ufo');
  fs.rmSync(ufoDir, { recursive: true, force: true });

  console.log(`Tracing ${Object.keys(labels).length} glyphs to cubic bezier (img2bez → UFO)…`);
  const { glyphCount } = await traceToUFO(dir, labels, blobs, ufoDir, {
    variants,
    weight: Number(opt.weight),
    smooth: Number(opt.smooth),
    name: opt.name,
  });
  if (!glyphCount) fail('No glyphs traced. Check your labels and crops.');

  // Generate the "live font" calt feature when variants exist. The variant map
  // {char: [crop, ...]} becomes {char: count}; livefont.generateCalt emits a
  // .fea that cycles the alternates. An explicit --features file overrides this.
  let feaPath = opt.features;
  if (!feaPath && variants) {
    const { generateCalt } = require('./livefont');
    const altCounts = {};
    for (const [ch, crops] of Object.entries(variants)) {
      if (crops && crops.length) altCounts[ch.normalize('NFC')] = crops.length;
    }
    const { feaText, lookupCount } = generateCalt(altCounts);
    if (feaText) {
      feaPath = path.join(dir, 'calt.fea');
      fs.writeFileSync(feaPath, feaText);
      console.log(`Live font: cycling ${lookupCount} alternate(s) via GSUB calt.`);
    }
  }

  // Map --formats into what assemble_cff produces. Default to otf (the premium
  // CFF format); css is generated Node-side after compilation.
  const want = opt.formats.split(',').map((s) => s.trim().toLowerCase());
  const pyFormats = [];
  if (want.includes('otf')) pyFormats.push('otf');
  if (want.includes('ttf')) pyFormats.push('ttf');
  // woff/woff2 wrap whichever of otf/ttf was produced; only add if a binary
  // base format is also present (the Python side wraps the base it compiled).
  if (want.includes('woff')) pyFormats.push('woff');
  if (want.includes('woff2')) pyFormats.push('woff2');
  if (!pyFormats.some((f) => f === 'otf' || f === 'ttf')) pyFormats.unshift('otf');

  const name = opt.name;
  const base = opt.out ? opt.out.replace(/\.\w+$/, '') : path.join(dir, name.replace(/\s+/g, ''));
  fs.mkdirSync(path.dirname(path.resolve(base)), { recursive: true });

  console.log(`Compiling UFO → ${pyFormats.join(', ')} (fonttools, CFF${feaPath ? ' + GSUB' : ''})…`);
  const summary = compileFont(ufoDir, name, base, pyFormats, feaPath);
  const written = summary.written.slice();

  if (want.includes('css')) {
    const { fontFaceCSS } = require('./assemble');
    fs.writeFileSync(`${base}.css`, fontFaceCSS(name, path.basename(base)));
    written.push(`${base}.css`);
  }

  console.log(`Built ${summary.glyphCount} glyphs (cubic bezier, CFF${summary.hasGSUB ? ' + GSUB' : ''}) → ${written.join(', ')}`);
  if (!summary.hasCFF) console.warn('  ! no CFF table in output (expected for max track)');
  const missing = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'].filter((c) => !labelsHas(labels, c));
  if (missing.length) console.log(`Letters not in this font yet: ${missing.join(' ')}`);
}

function labelsHas(labels, char) {
  return Object.values(labels).some((v) => v.normalize('NFC') === char);
}

// Like resolveLabels, but when there are MORE blobs than unique characters
// (e.g. several photos of the same alphabet), the duplicate occurrences become
// "live font" variants instead of being discarded. This is what makes the live
// font a one-liner: `make photo1.jpg photo2.jpg --chars "ABC" --quality max`
// with no manual --variants file. Returns { labels, autoVariants } where
// autoVariants maps char -> array of crop paths for the 2nd..Nth occurrence.
function resolveLabelsAndVariants(blobs, opt, CHARSETS) {
  let chars;
  if (opt.chars) chars = [...opt.chars.normalize('NFC').replace(/\s+/g, '')];
  else if (opt.charset) {
    chars = CHARSETS[opt.charset];
    if (!chars) fail(`Unknown charset "${opt.charset}". Available: ${Object.keys(CHARSETS).join(', ')}`);
  } else {
    fail('Provide --labels labels.json, --chars "…", or --charset <name>.');
  }
  // Cycle the chars list across all blobs: photo1 A,B,C then photo2 A,B,C maps
  // as A,B,C,A,B,C. The first occurrence of each char is the base glyph; every
  // later occurrence is a variant crop for that char.
  const ids = blobs.blobs.map((b) => b.id);
  const crops = blobs.blobs.map((b) => b.crop);
  const labels = {};
  const autoVariants = {};
  const seen = new Set();
  for (let i = 0; i < ids.length; i++) {
    const ch = chars[i % chars.length]; // cycle so 2nd photo reuses the alphabet
    if (seen.has(ch)) {
      (autoVariants[ch] = autoVariants[ch] || []).push(crops[i]);
    } else {
      labels[ids[i]] = ch;
      seen.add(ch);
    }
  }
  const variantTotal = Object.values(autoVariants).reduce((s, a) => s + a.length, 0);
  if (variantTotal) {
    console.log(`  ! ${variantTotal} duplicate glyph(s) auto-promoted to live-font variants across ${Object.keys(autoVariants).length} letter(s).`);
  }
  return { labels, autoVariants };
}

function resolveLabels(blobs, opt, CHARSETS) {
  if (opt.labels) {
    const map = readJSON(opt.labels, '');
    return Object.fromEntries(Object.entries(map).filter(([, v]) => v));
  }
  let chars;
  if (opt.chars) chars = [...opt.chars.normalize('NFC').replace(/\s+/g, '')];
  else if (opt.charset) {
    chars = CHARSETS[opt.charset];
    if (!chars) fail(`Unknown charset "${opt.charset}". Available: ${Object.keys(CHARSETS).join(', ')}`);
  } else {
    fail('Provide --labels labels.json, --chars "…", or --charset <name>.');
  }
  const ids = blobs.blobs.map((b) => b.id);
  if (chars.length !== ids.length) {
    console.warn(
      `  ! ${ids.length} blobs found but ${chars.length} characters given - mapping in order, extras ignored.\n` +
      `    If this is unexpected, inspect the contact sheet and use --labels for exact control.`
    );
  }
  return Object.fromEntries(ids.slice(0, chars.length).map((id, i) => [id, chars[i]]));
}

function readJSON(file, hint) {
  if (!fs.existsSync(file)) fail(`${file} not found. ${hint}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

main().catch((err) => fail(err.stack || String(err)));
