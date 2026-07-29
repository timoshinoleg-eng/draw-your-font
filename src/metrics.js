'use strict';
// The craft step: place each traced glyph into a shared 1000-UPM em space.
// Every character has a vertical band (bottom..top in font units, baseline = 0);
// the glyph's ink is scaled uniformly to fill its band. This shared coordinate
// system - not per-glyph normalization - is what makes the result feel like a
// font instead of a ransom note.
const svgpath = require('svgpath');
const { fixWinding } = require('./winding');

const UPM = 1000;
const ASCENT = 800;
const DESCENT = -200;
const CAP = 700; // cap height
const XH = 480; // x-height
const DESC = -220; // descender depth
const ASC = 720; // ascender top (b, d, f, h, k, l)

const BANDS = new Map();
const set = (chars, band) => [...chars].forEach((c) => BANDS.set(c, band));

set('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', [0, CAP]);
set('ÑÁÉÍÓÚÜ', [0, ASCENT]); // caps with accents reach above cap height
set('bdfhkl', [0, ASC]);
set('t', [0, 640]);
set('acemnorsuvwxz', [0, XH]);
set('ñáéíóúü', [0, ASC]); // lowercase with marks above x-height
set('i', [0, 660]);
set('j', [DESC, 660]);
set('gpqy', [DESC, XH]);
set('.', [0, 110]);
set(',', [-140, 110]);
set(':', [0, XH]);
set(';', [-140, XH]);
set('!?', [0, CAP]);
set("'’", [480, CAP]);
set('"“”', [480, CAP]);
set('-–—', [250, 350]);
set('_', [-120, -40]);
set('()[]{}', [-160, ASC]);
set('@', [-50, 650]);
set('#&%', [0, CAP]);
set('+', [110, 550]);
set('=', [180, 480]);
set('*', [420, CAP]);
set('$€£', [-40, 730]);
set('/\\|', [-100, ASC]);
set('<>', [110, 550]);
set('~', [220, 420]);
set('^', [450, CAP]);
set('¿¡', [DESC, XH]);

// --- Cyrillic (Russian). Mirrors the Latin band logic but for the 33 Russian
// letters. The vertical classes map onto the same em-square zones (cap, x-height,
// ascender, descender, mark-above). Letters are grouped by their height class.

// Uppercase base — all reach cap height, like Latin capitals.
set('АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ', [0, CAP]);
// Uppercase with a diacritic (Й breve, Ё dieresis) reach above cap, like Ñ.
set('ЙЁ', [0, ASCENT]);
// Lowercase with a mark above (й, ё) sit at x-height + mark room, like ñ.
set('йё', [0, ASC]);
// Lowercase ascender — б has a stem rising above x-height, like Latin b/d.
set('б', [0, ASC]);
// Lowercase ф is tall (two large bowls); place near ascender height.
set('ф', [0, ASC]);
// Lowercase descenders — р and у drop below baseline, like Latin g/p/q/y.
set('ру', [DESC, XH]);
// Lowercase with a short tail (ц, щ) — small descender for the tail only.
set('цщ', [-90, XH]);
// Lowercase base — the rest sit at x-height between baseline and x-line.
set('авгдежзиклмнопстхчшъыьэюя', [0, XH]);

function band(char) {
  return BANDS.get(char) || [0, CAP];
}

/**
 * Transform a traced path from crop pixel coords into em space.
 * @param {string} d potrace path in crop coordinates (y down)
 * @param {{width:number,height:number}} cropSize full crop incl. padding
 * @param {number} pad padding used when cropping
 * @param {string} char the character this glyph represents
 * @param {{lsb?:number,rsb?:number}} opts sidebearings in font units
 * @returns {{d: string, advance: number}} path in font coords (y up, baseline 0)
 */
function placeGlyph(d, cropSize, pad, char, { lsb = 50, rsb = 50 } = {}) {
  const inkW = cropSize.width - 2 * pad;
  const inkH = cropSize.height - 2 * pad;
  const [bot, top] = band(char);
  const s = (top - bot) / inkH;
  const placed = svgpath(d)
    .translate(-pad, -pad)
    .scale(s, -s)
    .translate(lsb, top)
    .round(1)
    .toString();
  return { d: fixWinding(placed), advance: Math.round(lsb + inkW * s + rsb) };
}

module.exports = { UPM, ASCENT, DESCENT, XH, CAP, band, placeGlyph };
