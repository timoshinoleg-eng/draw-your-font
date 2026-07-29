'use strict';
// The "live font": turn multiple real handwriting samples of the same letter
// into a font that cycles through them, so a paragraph of handwriting doesn't
// show the same 'a' five times in a row.
//
// Mechanism (the key design choice, learned from kako-jun/jitter):
//   We use GSUB with the `calt` (Contextual Alternates) feature, NOT `rand`.
//   `rand` is poorly supported (mostly InDesign only). `calt` is a contextual
//   substitution that every modern browser ships, so the alternation works on
//   the actual web — which is where a handwriting font gets used.
//
// Cycling scheme: a single forward-step lookup per character maps EACH form
// (base, alt1, alt2, ...) to the NEXT form in the cycle
// (base -> alt1 -> alt2 -> ... -> base). A chain-context rule fires that step
// only when the immediately preceding glyph is one of that letter's forms
// (base OR any alt). So:
//   "aaaaa"  ->  base, alt1, alt2, base, alt1   (cycles through all k variants)
//
// This is correct for any k >= 1: the backtrack matches a glyph CLASS of all
// forms, so once a glyph has stepped to alt1 the next 'a' still sees a
// matching predecessor and steps to alt2. The earlier "count preceding base
// glyphs" scheme only worked for k<=2 and silently collapsed k>2 to 2 forms.
//
// This module generates the .fea (Adobe Feature) text; assemble_cff.py feeds
// it to fontTools/feaLib when compiling the UFO, so the GSUB table is built
// from real, hand-traced alternates — not synthetic jitter noise.

/**
 * Generate the calt feature rules that cycle alternates per occurrence.
 *
 * @param {Object.<string, number>} altCounts map: char -> number of alternates
 *        available (e.g. {a: 3, e: 2}). Only chars with >=1 alternate cycle.
 * @returns {{feaText:string, lookupCount:number}} the feature file body
 */
function generateCalt(altCounts) {
  const lines = [];
  lines.push('# draw-your-font "live" feature: contextual alternates (calt).');
  lines.push('# Cycles real handwriting variants so repeated letters are not identical.');
  lines.push('# Uses calt (broader browser support), not rand (InDesign-only).');
  lines.push('');

  const chars = Object.keys(altCounts).filter((c) => altCounts[c] > 0).sort();
  if (!chars.length) return { feaText: '', lookupCount: 0 };

  // One forward-step lookup per character. Each maps every form of that letter
  // to the next form in its cycle (base->alt1->...->base), so a run of the
  // same letter walks the whole cycle rather than alternating between two.
  let lookupCount = 0;
  for (const ch of chars) {
    const k = altCounts[ch];
    const base = glyphName(ch);
    const forms = [base, ...Array.from({ length: k }, (_, i) => `${base}.alt${i + 1}`)];
    // form[i] steps to form[i+1]; the last (altN) steps back to the base.
    lines.push(`lookup step_${base} {`);
    for (let i = 0; i < forms.length; i++) {
      const from = forms[i];
      const to = forms[(i + 1) % forms.length];
      lines.push(`  sub ${from} by ${to};`);
    }
    lines.push(`} step_${base};`);
    lines.push('');
    lookupCount++;
  }

  // Chain-context rules: substitute the marked glyph (any form of the letter)
  // with its next-cycle form, but ONLY when the preceding glyph is also one of
  // that letter's forms. The glyph class in both backtrack and input positions
  // is what makes the step chain correctly across the whole cycle.
  lines.push('feature calt {');
  for (const ch of chars) {
    const k = altCounts[ch];
    const base = glyphName(ch);
    const allForms = [base, ...Array.from({ length: k }, (_, i) => `${base}.alt${i + 1}`)];
    const cls = `[${allForms.join(' ')}]`;
    // fea chain syntax: backtrack class, then marked input class, then lookup.
    lines.push(`  sub ${cls} ${cls}' lookup step_${base};`);
  }
  lines.push('} calt;');
  lines.push('');

  return { feaText: lines.join('\n'), lookupCount };
}

/**
 * Standard UFO/OpenType glyph name for a character: uniXXXX.
 */
function glyphName(ch) {
  return 'uni' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Generate a `liga` feature for common letter pairs, so "th", "he", "in"
 * join naturally when the font contains dedicated ligature glyphs.
 *
 * Borrowed in spirit from kalam's ligature mining. Unlike kalam (which mines
 * real joined strokes from reMarkable input), here the ligature glyphs must be
 * supplied explicitly as variants (the live-font --variants mechanism): if a
 * pair like "th" has a crop, it becomes a two-glyph ligature substitution.
 *
 * @param {Object.<string,string>} ligatures map "pair" -> alternate glyph name
 *        base, e.g. {th: 'uni0074_h_alt1'}; only pairs with glyphs get rules.
 * @returns {string} fea text (empty if no ligatures)
 */
function generateLiga(ligatures) {
  const pairs = Object.keys(ligatures).filter((p) => p.length === 2);
  if (!pairs.length) return '';
  const lines = [];
  lines.push('# draw-your-font ligatures (liga): join common letter pairs.');
  lines.push('');
  lines.push('feature liga {');
  for (const pair of pairs.sort()) {
    const [a, b] = [...pair];
    const ga = glyphName(a);
    const gb = glyphName(b);
    const lig = ligatures[pair];
    lines.push(`  sub ${ga} ${gb} by ${lig};`);
  }
  lines.push('} liga;');
  lines.push('');
  return lines.join('\n');
}

module.exports = { generateCalt, generateLiga, glyphName };
