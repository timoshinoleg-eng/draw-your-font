#!/usr/bin/env python3
"""Compile a UFO font source into an OTF (CFF, cubic bezier) or TTF.

This is the MAX-quality track of draw-your-font: img2bez writes cubic
bezier outlines into a UFO (source of truth, font-designer structure),
and fonttools/ufo2ft compiles it into a final binary font.

Inputs : a UFO directory written by img2bez (one glyph per letter),
         plus the family name and desired output formats.
Outputs: .otf (CFF), .ttf, .woff, .woff2 as requested.

Usage (called from Node via child_process):
    python assemble_cff.py <ufo_dir> <family_name> <out_base> <formats_csv>
    python assemble_cff.py --features <fea_path> <ufo_dir> ... <formats_csv>
                          ^ optional explicit .fea (GSUB/GPOS rules)
"""
import sys
import os
import re
import json

# fontTools: the industry-standard free font library (MIT).
from fontTools import ttLib
from ufo2ft import compileOTF, compileTTF
import ufoLib2


def compile_font(ufo_dir, family_name, out_base, formats_csv, fea_path=None):
    """Compile a UFO to the requested binary formats.

    ufo_dir      : path to the .ufo produced by img2bez
    family_name  : font family name (written into name table)
    out_base     : path stem, e.g. 'work/DansHand' -> DansHand.otf
    formats_csv  : comma list: otf,ttf,woff,woff2
    fea_path     : optional path to a .fea feature file with GSUB/GPOS
                   (contextual alternates, ligatures, kerning). If given,
                   it is loaded into the UFO's features before compiling.
    """
    formats = [f.strip().lower() for f in formats_csv.split(',') if f.strip()]
    if not os.path.isdir(ufo_dir):
        sys.exit(f"UFO not found: {ufo_dir}")

    # ufo2ft wants a loaded UFO object (not a path). ufoLib2 is the modern,
    # lightweight reader that ufo2ft is tested against; it reads the
    # fontinfo.plist (unitsPerEm, ascender/descender) img2bez wrote.
    ufo = ufoLib2.Font.open(ufo_dir)

    # If an explicit .fea feature file was provided (live-font / calt), set it
    # on the in-memory UFO object so ufo2ft/feaLib compiles the GSUB/GPOS tables
    # from it. Setting ufo.features.text is the supported way (writing to disk
    # would be ignored — the object is already loaded).
    if fea_path and os.path.isfile(fea_path):
        with open(fea_path, 'r', encoding='utf-8') as fh:
            ufo.features.text = fh.read()

    written = []

    # CFF (cubic bezier) is the premium output: smoother organic curves,
    # fewer points, the format professional type designers ship for
    # handwriting/script fonts. Compile first; other formats derive from it
    # or from the UFO directly.
    if 'otf' in formats:
        # removeOverlaps=False -> no overlap removal, so overlapsBackend is not
        # needed. Passing it anyway is version-fragile across ufo2ft releases,
        # so we omit it entirely (the safer, documented call shape).
        otf = compileOTF(ufo, inplace=False, removeOverlaps=False, optimizeCFF=1)
        _set_names(otf, family_name)
        _write_font(otf, out_base + '.otf')
        written.append(out_base + '.otf')
        # WOFF/WOFF2 wrap the OTF (keeps CFF curves).
        if 'woff' in formats:
            _wrap_woff(otf, out_base + '.woff')
            written.append(out_base + '.woff')
        if 'woff2' in formats:
            _wrap_woff2(otf, out_base + '.woff2')
            written.append(out_base + '.woff2')

    # TTF (quadratic) — separate compilation for editors/systems that need
    # glyf outlines. Keeps a complete track even without the CFF path.
    if 'ttf' in formats:
        ttf = compileTTF(ufo, inplace=False, removeOverlaps=False)
        _set_names(ttf, family_name)
        _write_font(ttf, out_base + '.ttf')
        written.append(out_base + '.ttf')
        # WOFF/WOFF2 wrap the TTF if OTF was not produced.
        if 'otf' not in formats:
            if 'woff' in formats:
                _wrap_woff(ttf, out_base + '.woff')
                written.append(out_base + '.woff')
            if 'woff2' in formats:
                _wrap_woff2(ttf, out_base + '.woff2')
                written.append(out_base + '.woff2')

    # Report: glyph count + tables present (lets Node validate success).
    sample = ttLib.TTFont(written[0]) if written else None
    glyph_count = (len(sample.getGlyphOrder()) - 1) if sample else 0  # minus .notdef
    has_gsub = bool(sample and 'GSUB' in sample) if sample else False
    has_cff = bool(sample and 'CFF ' in sample) if sample else False
    print(json.dumps({
        'written': written,
        'glyphCount': glyph_count,
        'hasGSUB': has_gsub,
        'hasCFF': has_cff,
    }))


def _set_names(ttfont, family_name):
    """Set the family + unique identifier in the name table."""
    name = ttfont['name']
    name.setName(family_name, 1, 3, 1, 0x409)   # family
    name.setName(family_name, 2, 3, 1, 0x409)   # subfamily (Regular)
    name.setName(family_name, 16, 3, 1, 0x409)  # typographic family
    name.setName('Regular', 17, 3, 1, 0x409)    # typographic subfamily
    name.setName(f"{family_name} - made with draw-your-font", 3, 3, 1, 0x409)
    # nameID 6 (PostScript name): restricted charset, no spaces, <= 63 chars.
    # "draw-your-font: Name" would be invalid (space + colon); sanitize it.
    ps_name = "DrawYourFont-" + re.sub(r'[^A-Za-z0-9-]', '', family_name.replace(' ', '-'))[:40]
    name.setName(ps_name, 6, 3, 1, 0x409)


def _write_font(ttfont, path):
    ttfont.save(path)


def _wrap_woff(ttfont, path):
    from fontTools.ttLib import TTFont
    # fontTools WOFF writer via the WOFFFlavorData; simplest is re-save with flavor.
    ttfont.flavor = 'woff'
    ttfont.save(path)
    ttfont.flavor = None  # reset in-memory object


def _wrap_woff2(ttfont, path):
    # wawoff2 (brotli) is used by the Node side already; here use fontTools'
    # brotli-backed WOFF2 writer.
    ttfont.flavor = 'woff2'
    ttfont.save(path)
    ttfont.flavor = None


def main(argv):
    # Two call shapes:
    #   assemble_cff.py <ufo> <name> <out_base> <formats>
    #   assemble_cff.py --features <fea> <ufo> <name> <out_base> <formats>
    fea_path = None
    args = argv[1:]
    if args and args[0] == '--features':
        fea_path = args[1]
        args = args[2:]
    if len(args) != 4:
        sys.exit("usage: assemble_cff.py [--features fea] <ufo> <name> <out_base> <formats>")
    ufo_dir, family_name, out_base, formats_csv = args
    compile_font(ufo_dir, family_name, out_base, formats_csv, fea_path)


if __name__ == '__main__':
    main(sys.argv)
