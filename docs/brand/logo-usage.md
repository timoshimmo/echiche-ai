# Echiche logo — usage guide

Visual version: `brand/guide/echiche-logo-guide.png` (source: `brand/guide/logo-guide.html`).

## The mark
Clean vector rebuild of the mark in `brand/moodboard.png` (the moodboard is inspiration only —
always use the files below). Three ring nodes — **idea** (left, sage), **evidence** (top, lime)
and **decision** (right, lime) — joined by one continuous line that sweeps, loops back through
the centre, and carries on: thinking kept connected over time.

- On light grounds the rings are ink and the colour sits in each node's centre (lime is too
  faint as a thin ring on ivory/white). On ink grounds the rings themselves are lime and sage.
- Node holes are cut out of the line, so every version is genuinely one flat colour on any background.
- Below 40px a **reduced drawing** is used (the bottom loop is removed, lines are heavier) so the
  crossings don't fill in at favicon size.

Wordmark: ECHICHE in Instrument Sans Medium, +24% tracking. Tagline: Think Further. in Fraunces.

## Files — `public/brand/`
| Need | SVG (`svg/`) | PNG (`png/`, transparent) |
|---|---|---|
| Horizontal logo (primary) | `echiche-logo-{colourway}.svg` | `…-600/1200/2400.png` |
| Stacked logo with tagline (moodboard primary) | `echiche-logo-stacked-{colourway}.svg` | `…-600/1200/2400.png` |
| Horizontal logo with tagline | `echiche-logo-tagline-{colourway}.svg` | `…-600/1200/2400.png` |
| Symbol only | `echiche-symbol-{colourway}.svg` | `…-256/512/1024.png` |
| Symbol for 16–32px | `echiche-symbol-small-{colourway}.svg` | — |
| Favicon | `echiche-favicon.svg` (also `app/icon.svg`, `app/favicon.ico` 16/32/48) | — |
| App icon (full-bleed) | `echiche-app-icon-ink.svg`, `…-ivory.svg` | `…-512/1024.png`; `app/apple-icon.png`; `public/icons/` |
| Hero illustration (fine-line version, website only) | `echiche-path-illustration.svg` | — |
| Social preview | `echiche-social-preview.svg` | `echiche-social-preview-1200x630.png` |

Colourways: `colour` (light grounds) · `colour-dark` (ink grounds) · `mono-ink` (one-colour dark) · `mono-white` (one-colour light).

## Clear space
Keep **x = ¼ of the symbol's height** clear on all sides (about two node diameters).
No text, edges or other marks inside it.

## Minimum size
- Horizontal logo: **96px** wide on screen, **25mm** in print. Tagline lockup: 140px / 35mm.
- Symbol: regular files from **40px**; from 16px to 39px use the **small** files or favicon
  (heavier lines keep the loop open). Never below 16px.

## Colour
| Ground | Use |
|---|---|
| Ivory #FAF9F4 or white | `colour` |
| Ink #0F202A | `colour-dark` |
| Lime #D7FF5C, sage #7B9B81, light photos | `mono-ink` |
| Sage, dark photos | `mono-white` |

Every version is flat colour with no gradients (the moodboard's two-tone rings are deliberately flattened).

## Misuse — don't
- Stretch, squash, rotate, skew or re-space anything.
- Recolour the nodes, or use the light version on dark grounds (or vice versa).
- Put the colour version on lime (the lime nodes disappear).
- Add shadows, glows, outlines, gradients or textures.
- Fill the node holes, add gradients to the rings, or redraw the line.
- Use the full mark below 40px — use the small files.
- Retype the wordmark or rearrange the lockup. Use only the supplied files.

## Editing / regenerating
Everything is generated from one geometry definition in `brand/tools/build-logo.py`:
```
pip install fonttools brotli cairosvg pillow
python3 brand/tools/build-logo.py .
```
SVGs are clean and editable in Figma/Illustrator: the symbol is one stroked path (`line`) plus three
ring circles (`idea`, `evidence`, `decision`), with the holes cut by a clip path; the wordmark and tagline are outlined paths.
Fonts (SIL OFL) are in `app/fonts/`.
