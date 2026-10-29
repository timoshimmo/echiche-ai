# Echiche design system

The design system turns the supplied Echiche brand (logo kit and moodboard) into tokens and components. It does not invent a new identity.

| What | Where it lives |
|---|---|
| Tokens and component styles | `src/app/globals.css`, sections 1–3 |
| Behaviour components | `src/app/ui/primitives.tsx` |
| Brand files | `public/brand/` |
| Usage rules from the kit | `docs/brand/logo-usage.md` |

## Principles
- **Calm, editorial, precise.** Ivory ground, white working surfaces, ink for authority. Rounded cards, shadows and decoration are used sparingly.
- **Honest states only.** Progress, badges and empty states reflect real backend data. There are no invented percentages, statistics or activity.
- **Words before colour.** Every status has a text label. Colour reinforces the label and never carries the meaning alone.
- **Lime is a highlight, not a theme.** At most one lime element is in focus at a time, and it is always paired with ink.

## Colour
Contrast is measured with the WCAG 2.x formula (`contrast.py` during Stage 2). AA requires 4.5:1 for body text and 3:1 for large text and UI boundaries.

### Brand palette (logo kit)

| Token | Hex | Use | Measured contrast |
|---|---|---|---|
| `--color-ivory` | #FAF9F4 | App background | — |
| `--color-ink` | #0F202A | Text, navigation, primary buttons | 15.8:1 on ivory, 16.7:1 on white |
| `--color-sage` | #7B9B81 | Control borders, rules, "done" markers | 3.07:1 on white (meets the UI 3:1 minimum). **Not for text:** 2.9:1 on ivory. |
| `--color-lime` | #D7FF5C | Focal highlight: active stage, focus on ink, accent button | 14.6:1 with ink. **Never on light grounds:** 1.09:1 on ivory. |
| `--color-white` | #FFFFFF | Cards, inputs, dialogs | — |

### Derived tokens (added only where the brand colour fails for a use)

| Token | Hex | Why | Contrast |
|---|---|---|---|
| `--color-ink-soft` | #3B4A52 | Secondary text | 8.7:1 on ivory |
| `--color-muted` | #56636B | Hints, metadata | 5.9:1 on ivory, 6.2:1 on white, 5.5:1 on sage tint |
| `--color-sage-deep` | #4F6B55 | Sage that must be read (eyebrows, success text) | 5.6:1 on ivory, 5.2:1 on sage tint |
| `--color-sage-tint` | #EEF3EF | Selected or supportive surfaces | Ink on it: 14.8:1 |
| `--color-ivory-deep` | #F3F1E8 | Recessed wells and quotes | Ink on it: 14.7:1; muted: 5.5:1 |
| `--color-line`, `--color-line-strong` | #E4E2D8, #CFD6CF | Decorative hairlines and card borders | Decorative, no requirement |
| `--color-ink-raised` | #1B313D | Raised surface on ink | — |
| `--color-on-ink`, `--color-on-ink-muted` | #E9EEF0, #9FB0B8 | Text on ink | Muted: 7.4:1 on ink, 6.0:1 on raised ink |
| `--color-danger` / `-tint` | #9A3B2E / #F8ECE9 | Irreversible actions, errors | 6.9:1 on white, 6.0:1 on tint |
| `--color-warning` / `-tint` | #8A5A00 / #FBF3E2 | Stale, unknown, needs attention | 5.9:1 on white, 5.4:1 on tint |
| Placeholder | #687379 | Input placeholders | 4.9:1 on white |

**Focus:**
- Default: a 2px ink outline with a 2px offset.
- Inside `.on-ink` regions: the outline switches to lime.
- Inputs: an ink border plus a sage halo.

## Typography
The brand fonts are self-hosted via `@fontsource-variable/instrument-sans` and `@fontsource-variable/fraunces`. Both are SIL OFL 1.1 and pinned to 5.3.0. They are imported in `layout.tsx`.

Self-hosting means no third-party requests, which closes M8 finding F10. The CSP now allows fonts and styles from `'self'` only. The browser downloads only the latin subsets a page uses: the latin variable `.woff2` files are about 30 KB (Instrument Sans) and 37 KB (Fraunces).

| Role | Font | Where |
|---|---|---|
| Interface and reading | Instrument Sans (variable 400–700) | Everything functional: navigation, forms, data, reasoning, evidence, briefs |
| Display | Fraunces (variable), via the `.display` class | Page titles and the brief's recommendation headline only. Never for long passages. |
| Data | System monospace (`--font-mono`) | IDs and exact figures (source IDs, token counts) |

Scale (rem, based on 16 px):

| Token | Size | Use |
|---|---|---|
| `--text-xs` | 12 px | Metadata, badges |
| `--text-sm` | 13 px | Labels, secondary text |
| `--text-md` | 15 px | Body |
| `--text-lg` | 17 px | Long reading (brief rationale) |
| `--text-xl` | 22 px | Section titles |
| `--text-2xl` | 28 px | — |
| `--text-3xl` | 36 px | — |
| `--text-4xl` | clamp 36–52 px | Page heroes |

- **Weights:** 400 regular, 500 medium, 600 semibold (headings, buttons), 700 sparingly.
- **Line height:** 1.2 for headings, 1.55 for UI, 1.7 for reading.

## Space, shape, depth, layout
- **Spacing:** 4 px base. Tokens `--space-1` to `--space-10` = 4, 8, 12, 16, 20, 24, 32, 40, 48, 64.
- **Radii:** 6 (tags), 10 (controls, notices), 14 (cards, dialogs), pill (badges).
- **Borders:** 1 px `--color-line-strong` on cards; sage on form controls.
- **Shadows:** `--shadow-sm` for subtle lift; `--shadow-lg` only for floating layers (dialogs, menus). Cards are flat.
- **Layout:**
  - Content max width 1180 px.
  - Reading width 720 px (briefs, legal).
  - Gutter 32 px on desktop, 16 px on phones.
  - Header 64 px.
- **Breakpoints:** CSS custom properties can't be used in media queries, so these are written literally:

| Breakpoint | Range |
|---|---|
| Phone | ≤ 600 px |
| Tablet | 601–900 px |
| Laptop / desktop | > 900 px |

  Desktop is the primary experience for intensive work. Phones can inspect and continue it.

## Components

| Component | Markup | Rules |
|---|---|---|
| Button | `.btn` plus `.btn-primary` / `.btn-secondary` / `.btn-ghost` / `.btn-danger` / `.btn-accent`; `.btn-sm`, `.btn-block` | Minimum height 44 px (touch target). One primary per view. Danger only for irreversible actions, and its label names the action. Disabled = 45% opacity plus `not-allowed`. |
| Field | `<Field label hint error>{props => <input className="input" {...props}/>}</Field>` | Label, hint and error linked by id and `aria-describedby`; `aria-invalid` when an error is set. |
| Input / textarea / select | `.input`, `.textarea`, `.select` | White fill, sage border (3:1), ink border plus sage halo on focus. Custom select chevron, native behaviour. |
| Card / well / divider | `.card`, `.well`, `.divider` | Cards are the working surface; avoid nesting them. |
| Badge | `<Badge tone>` (`success`, `warning`, `danger`, `focus` lime, `ink`) | Always text; the dot is decorative. |
| Epistemic label | `.label-tag .label-{fact,inference,hypothesis,speculation,unknown}` | A dashed border means speculative. Unknown uses the warning tone. A label never implies verification. |
| Notice | `<Notice tone>` | `role="alert"` for errors, `role="status"` otherwise. Optional dismiss. |
| Empty state | `<EmptyState title action>` | States what is missing and offers the next real action. Uses the brand path illustration as decoration (`alt=""`). |
| Loading | `<Spinner label>`, `<Skeleton lines>` | A spinner for actions, a skeleton for content. Both stop under reduced motion. |
| Tabs | `<Tabs tabs selected onSelect label idPrefix>` | WAI-ARIA tabs: arrow keys, Home and End; one tab stop. Panels: `id="{idPrefix}-panel-{id}"`, `role="tabpanel"`. |
| Dialog | `<ConfirmDialog open title confirmLabel danger busy>` | Native `<dialog>` + `showModal()`: focus trap, Esc cancels, background inert. Cancel gets initial focus for destructive dialogs. |
| Disclosure (tooltip alternative) | `<details class="disclosure">` | No hover-only information. Short hints use `title` only as a supplement to visible text. |
| Stage timeline | `<ol class="timeline">` with `li.done/.active/.skipped` | States come from `completedStages` and `status`. The active stage has a moving lime marker; skipped stages are dashed. No percentages. |
| Logo | `<Logo variant tone>` | Supplied SVG files only (see below). |

Notifications are notices. There are no toasts and no push notifications, because the product has no notification capability.

## Logo and icons
The files in `public/brand/` are the kit's files, unmodified:
- the horizontal logo, the tagline lockup and the stacked logo;
- the symbol (regular and small);
- the path illustration and the social preview.

Each comes in colour and colour-dark.

| Rule from `logo-usage.md` | How the app applies it |
|---|---|
| Colour logo on light grounds; colour-dark on ink | `<Logo tone="dark">` on ink surfaces |
| Horizontal logo at least 96 px wide; tagline lockup at least 140 px | The header lockup is 40 px tall, about 148 px wide |
| Small symbol variant below 40 px | Used for compact marks |
| Clear space: ¼ of the symbol's height | Kept by the padding around the header logo |

App icons use Next.js file conventions:
- `src/app/icon.svg` is the kit's favicon SVG.
- `src/app/favicon.ico` is the kit's ICO.
- `src/app/apple-icon.png` is the kit's ink app icon, resized to 180 px.

Middleware leaves `/brand/*`, `/icon.svg`, `/apple-icon.png` and `/favicon.ico` public, so the sign-in page can show the logo before sign-in.

The brand tagline **"Think Further."** appears in the tagline lockup and the page title.

## Motion
- **Durations:** 120 ms for state changes, 180 ms for larger changes.
- **Allowed animation:** the active-stage marker and loading indicators only. Nothing decorative.
- **Reduced motion:** `prefers-reduced-motion: reduce` turns off all animation and transitions.

## Adding to the system
1. Use an existing token. If none fits, add a token here with its measured contrast and the reason.
2. Put a new component in `src/app/ui/` only when it carries markup or behaviour that must stay consistent; plain styling stays a CSS class.
3. Add a render test in `src/app/ui/primitives.test.ts` for any accessibility wiring.
