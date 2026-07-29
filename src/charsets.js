'use strict';
const MINIMAL = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ...'abcdefghijklmnopqrstuvwxyz',
  ...'0123456789',
  ...`.,;:!?'"-()@#&+/$`,
];
const SPANISH = [...MINIMAL, ...'ÑñÁÉÍÓÚáéíóúü¿¡'];

// Russian alphabet. Modern Russian uses 33 letters (А-Я а-я + Ёё). Includes
// the hard (Ъъ) and soft (Ьь) signs and Ё. Excludes archaic letters (Ѣ Ѧ Ѯ...).
// Order is the standard alphabet order — a template prints cells in this order,
// so a filled template needs no recognition (the position IS the label).
const CYRILLIC = [
  ...'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ', // uppercase A..Ya (32)
  ...'абвгдежзийклмнопрстуфхцчшщъыьэюя', // lowercase a..ya (32)
  ...'Ёё',                                // Ё/ё (2) — sit after Я for natural flow
  ...MINIMAL,                             // digits + punctuation reuse the Latin set
];

module.exports = { CHARSETS: { minimal: MINIMAL, spanish: SPANISH, cyrillic: CYRILLIC } };
