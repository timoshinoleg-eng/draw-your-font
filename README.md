# draw-your-font

**Turn a photo of your handwriting into a real font (TTF/WOFF/WOFF2) - free, open source, no uploads, no credits.**

Draw your alphabet on paper. Take a photo. Get your font.

![A photo of a handwritten alphabet in a spiral notebook becoming an installable font](assets/hero.png)

*This is a real one-shot result: dim light, spiral binding, page shadow. One photo in, installable font out.*

## Use it as a Claude Code skill (the fun way)

```bash
npx skills add danilo-znamerovszkij/draw-your-font
```

Then in Claude Code, invoke the skill and hand it your photo:

> */draw-your-font* *"here's a photo of my handwriting - make my font"* (drag the photo into the terminal)

Claude finds your letters in the photo, labels them with vision, builds the
font, shows you a preview, and critiques its own work. Iterate by talking:

- *"make it rounder"* / *"a bit bolder"*
- *"the g looks bad"* - it shows you the crop and fixes or asks for a re-shoot
- *"give me woff2 + css for my website"*
- *"how readable is it?"* - a legibility score and the two worst letter pairs

No photo yet? Say *"give me a font template"* and you get a printable PDF grid:
write your alphabet with a dark pen, photograph the pages, and hand them back.
Messy freeform photos work too. Napkins, notebooks, spiral binding, bad
lighting: that's what the vision step is for.

Everything runs locally on your machine. Your handwriting never leaves it.

## Use it as a CLI (no AI at all)

The skill is a thin layer over a deterministic npm CLI. It works on its own
when you can tell it what you wrote:

```bash
# freeform photo, you know the order you wrote in:
npx draw-your-font make photo.jpg --chars "ABCabc" --name "My Hand"
# → MyHand.ttf - double-click, install, done.

# best quality: print a template, fill it, photograph:
npx draw-your-font template -o template.pdf --charset minimal   # or: spanish
npx draw-your-font make page1.jpg page2.jpg --charset minimal --name "My Hand"
```

Pure npm, zero system dependencies: no FontForge, no ImageMagick, no potrace
binary. Works on macOS / Linux / Windows wherever Node ≥ 18 runs.

### CLI reference

| Command | What it does |
|---|---|
| `template` | printable A4 PDF grid (`--charset minimal\|spanish`) |
| `segment <photos…>` | find letters → crops + numbered contact sheet + `blobs.json` |
| `build` | labeled crops → font (`--labels` / `--chars` / `--charset`) |
| `make <photos…>` | segment + build in one shot |
| `autolabel` | fallback: assign blobs to chars by shape (Hungarian algorithm) → `labels.json` |
| `qc` | score each glyph's trace quality (max track) → `qc-report.json` + weakest flagged |
| `preview` | render any text with the built font |

Refinement flags: `--smooth 0..2` (rounder curves), `--weight=-2..2`
(thinner/bolder), `--formats ttf,woff,woff2,css` (web-ready + `@font-face`
snippet). Run `draw-your-font --help` for everything.

### Maximum quality: cubic-bezier OTF (`--quality max`)

The default track (potrace → quadratic `glyf` → TTF) is fast and needs nothing
beyond Node. For the smoothest organic curves — the kind a professional
type designer ships for handwriting/script faces — switch to the **max track**:

```
photo ──► img2bez (cubic bezier) ──► UFO ──► fonttools (CFF + GSUB) ──► OTF
```

`img2bez` traces each crop to **cubic** Bézier outlines with structure a font
needs (extrema points, H/V handles, G2-harmonized joins), writing directly into
a UFO source. `fonttools` then compiles it to an OTF with a `CFF` table — fewer
points, smoother transitions, the format professional handwriting fonts ship in.

```bash
npx draw-your-font make photo.jpg --chars "ABCabc" --name "My Hand" --quality max --formats otf,woff2
```

The max track needs two extra (free, MIT) components: the `img2bez` binary
(build it with `cargo build --release` in its repo, or `cargo install --git
https://github.com/eliheuer/img2bez`) and Python with `fonttools`/`ufo2ft`
(`pip install fonttools ufo2ft ufoLib2 brotli`). Point the CLI at the binary via
the `DYF_IMG2BEZ` env var (or put it on PATH).

### The "live" font: authentic variation via `calt`

Every existing handwriting font looks robotic in a paragraph — each `a` is
identical. Real handwriting isn't. The max track can build a **live font**: feed
it several photos of the same letters, and it embeds each redrawn variant as a
named alternate, then wires them into a **GSUB `calt`** (Contextual Alternates)
feature that cycles them so consecutive identical letters differ. The variation
is *your real handwriting redrawn*, not synthetic jitter noise.

**One-liner** — the duplicates across photos auto-promote to variants, no manual
labeling:

```bash
# two photos of the same alphabet → a font where 'a' varies each time it repeats
npx draw-your-font make photo1.jpg photo2.jpg --chars "ABCabc" --quality max \
  --name "My Hand" --formats otf
```

The CLI detects that there are more glyphs than unique characters and turns the
extra occurrences into `calt` alternates automatically. For full control (e.g.
only some letters should vary), segment first and pass an explicit `--labels`
plus a `--variants` JSON mapping each letter to its extra crop paths.

Why `calt` and not `rand`: `rand` works almost only in InDesign; `calt` ships in
every modern browser, so the live font actually works on the web.

## How it works

```
photo ──► adaptive threshold ──► blob detection ──► label (Claude / you / template order)
      ──► potrace vectorize ──► shared em-square metrics ──► TTF/WOFF/WOFF2 + preview
```

The craft is in the metrics step: every character has a vertical band in a
shared 1000-unit em square (cap height, x-height, descender depth), so your
`g` hangs below the line and your `o` stays small. That's what makes it feel
like a font instead of a ransom note. Vectorization is potrace, the same
engine inside FontForge and Inkscape. AI never draws your letters; it only
finds, labels, and judges them.

## FAQ

**Who owns the font?** You. 100%, commercial use included. It's your
handwriting.

**Why is this free when Calligraphr charges $8/month?** Their cost is
servers and a browser editor. Here your machine does the work and the agent
is the editor.

**Kerning, ligatures, letter randomization?** Yes — on the max track
(`--quality max`). Letter randomization is the "live font" above: real redrawn
variants cycled via `calt`. Ligatures (`liga`) and kerning (`kern`) are wired in
through an explicit `.fea` file passed via `--features`. The base track
(`--quality base`, the default) ships a clean single-variant font with no
OpenType layout features — fast and dependency-free.

## License

MIT. Draw something.
