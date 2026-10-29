# Product experience audit (UI/UX phase, Stage 1)

- Date: 2026-10-29
- Baseline commit: `689b419` (M9 readiness record)
- Inputs:
  - the master UI/UX prompt;
  - the execution guide;
  - the Echiche logo kit (`echiche-logo-kit.zip`, with `logo-usage.md`);
  - the repository as it stands.
- Scope: this documents what the product **actually does today**. Nothing here is taken from the PRD alone. Every capability below was traced to a route handler and a component.

## 1. Baseline (before any UI change)

| Suite | Command | Result |
|---|---|---|
| Web unit | `npm test` | 108 passed (11 files) |
| Web typecheck | `npm run typecheck` | clean |
| Web integration (Postgres 16, migrated `m7_clean`) | `npm run test:integration` | 54 passed (5 files). One test failed on the first run straight after a cold database start, then passed on an immediate re-run. Recorded as a timing flake to watch, not a regression. |
| Worker unit | `uv run pytest -q` | 165 passed |
| Worker integration | `uv run pytest -q -m integration` | 48 passed |

Baseline screenshots, taken with a production build, the demo worker and a disposable database:
- **Files:** `login` and `home` at 1280 px and 390 px.
- **Checks:** no horizontal scroll at either width. The only console error is the blocked Google Fonts request; the sandbox has no route to Google.
- **Data:** the run was demo-mode (no AI model), and the screenshots were not committed. Seeded content was typed in through the UI against a throwaway database.

## 2. Current application structure

| Area | Today |
|---|---|
| Framework | Next.js 15.5 App Router, React 19.1, TypeScript strict. No UI or component library. |
| Styling | One global stylesheet, `src/app/globals.css` (about 12 KB, minified by hand). No CSS modules and no Tailwind. |
| Tokens | Seven CSS variables: `--ink #182720`, `--muted`, `--line`, `--paper #f7f8f3`, `--green #214b39`, `--lime #d5f07a`, `--white`. **These are not the brand palette** (see §4). |
| Fonts | DM Sans, DM Mono and Playfair Display via a Google Fonts `@import`. The brand fonts are Instrument Sans and Fraunces. Google Fonts also sends every visitor's IP to Google (M8 finding F10), and the CSP allows it only for this purpose. |
| Brand assets | **None in the app.** There is no `public/` folder, no favicon and no logo. The header shows a letter "E" in a green tile beside the lowercase text "echiche". |
| Routes (pages) | `/` (everything, one client component, 242 lines), `/login`, `/privacy`, `/terms`. |
| Components | `decision-brief.tsx` (brief, evidence and remembered context; presentational), `journal.tsx` (memory proposals, remembered items, decision journal, export and delete), `site-footer.tsx`. |
| Auth | Supabase magic link (PKCE). Middleware protects every page except `/login`, `/privacy`, `/terms`, `/auth/*` and `/api/*`; API routes enforce their own auth. A 401 from any API call sends the user to `/login`. |
| Responsive | Two `@media (max-width:760px)` blocks; the panels stack. There is no navigation to adapt, because there is no navigation. |
| Frontend tests | `legal-pages.test.ts` (server rendering plus the middleware matcher). Nothing else tests the UI. API, auth and security tests cover the behaviour behind it. |

## 3. Feature-to-interface mapping

Classification:
- **KEEP:** already right.
- **IMPROVE:** works, but the presentation or interaction needs refinement.
- **MISSING:** the backend supports it, but there is no UI.
- **BLOCKED:** the capability does not exist, so it is not built in this phase.

### Account and sign-in

| Existing capability | Current route / component | Current UI condition | Proposed improvement | Class |
|---|---|---|---|---|
| Magic-link sign-in, with error and "sent" states | `/login`, `POST /auth/sign-in`, `/auth/callback` | Clear messages, but the page reuses the marketing hero ("Think beyond the next answer") with no logo. The panel width is set inline. | Branded sign-in screen: the real symbol and wordmark, a short plain-language explanation of Echiche, a focused form, and the same messages. No password field exists, so no password controls. | IMPROVE |
| Sign-out | `POST /auth/sign-out` (form in the header) | Tiny monospace link | An account menu in the app shell: email plus sign-out. | IMPROVE |
| Current user | `GET /api/me` | Email shown in the header | Shown in the account menu, plus "Welcome back" on the overview. | IMPROVE |

### Projects and runs

| Existing capability | Current route / component | Current UI condition | Proposed improvement | Class |
|---|---|---|---|---|
| Create a project (title plus problem statement) | `POST /api/projects`; `page.tsx` panel "01" | Always-visible form competes with everything else on the page | A "New project" entry point on the overview and projects list, with guidance and an example as *placeholder* text (no fabricated projects). | IMPROVE |
| List projects | `GET /api/projects`; panel "02" | A flat list under the creation form. No dates, no status. The first project is auto-selected. | A projects list with title, purpose, last activity (`updatedAt`), and whether a brief awaits review (from run history). | IMPROVE |
| Rename or edit a project's problem statement | `PATCH /api/projects/:id` | **No UI** | Edit in the project header. | MISSING |
| Archive and unarchive a project | `PATCH {archived}`; `GET ?includeArchived=true`; runs refuse archived projects (409) | **No UI** | Archive action plus an "Archived" filter. Explain why runs are disabled while a project is archived. | MISSING |
| Start a thought run with a depth choice | `POST /api/projects/:id/runs` (idempotency key); panel "03" | Works; the depth hint is good | Becomes the primary action of the project workspace ("Ask a question" or "Think it through"). Keep the depth selector and its hints. | IMPROVE |
| Run progress | `GET /api/runs/:id`, polled every 1.5 s; stage chips | Honest (real stages; skipped stages marked) but visually small | A stage timeline: done / active / skipped / to do, from `completedStages` and `status` only. No percentages. A live region announces stage changes. | IMPROVE |
| Routing explanation (why Quick, Standard or Deep) | `run.route`; `<details>` | Engineering wording ("signal +2: …", "policy routing-policy.v1") | Plain-language summary, with the raw reasons kept in the disclosure. | IMPROVE |
| Cancel, resume after a budget pause, accept a brief | `POST /api/runs/:id/{cancel,resume,accept}` | Works | Clear primary and secondary hierarchy. "Accept" explains that it records the decision in the journal. | IMPROVE |
| **Run history per project** | `GET /api/projects/:id/runs` (latest 50) | **No UI.** A run is visible only while the page stays open; a reload loses it. This is readiness item **P0-2**. | A history list in the project workspace (prompt, status, date, depth). Opening a run shows its brief. Each run gets a deep link: `/projects/:id/runs/:runId`. | MISSING |
| Usage and budget | `run.usage`, `run.budget`, `run.generation` | Monospace lines | A quiet "Run details" section, keeping the exact figures. | IMPROVE |
| Run event log | `run.events` | `<details>` list | Keep, inside "Run details". | KEEP |

### Briefs, evidence, memory and journal

| Existing capability | Current route / component | Current UI condition | Proposed improvement | Class |
|---|---|---|---|---|
| Demo scaffold result (`reasoning-scaffold.v1`) | `page.tsx` | Has the eyebrow **"DECISION BRIEF"** but is a deterministic template, not a brief. Staging currently shows this, because no OpenAI key is set. | Label it honestly ("Starter structure, no AI model"), visually distinct from a real brief. | IMPROVE |
| Decision brief (`decision-brief.v1`) | `DecisionBriefView` | All fields present, but rendered as nine equal cards on a dark green panel. The recommendation does not stand out, and the reading order does not follow the decision. | A document layout in this order: question → recommendation and rationale → confidence → assumptions (with epistemic labels) → supporting evidence / counterevidence / strongest objection → alternatives → trade-offs → what would change it → next actions → limitations. On a light surface, readable on mobile. | IMPROVE |
| Model provenance (live model vs demo) | `generationLabel` / `generationDetail` | Present, small | Keep the wording; make it a clear badge. | KEEP (wording) / IMPROVE (presentation) |
| Evidence: sources, verified quotes, failed claims, freshness, contradictions | `EvidenceView`, `SourceItem` | All present. Links use `noopener noreferrer nofollow`. Visually dense. | An evidence section with explicit status badges (verified, partly supported, failed verification, stale, sources disagree). Cited versus read-but-not-cited stays separate. Epistemic labels: fact, inference, hypothesis, speculation, unknown. | IMPROVE |
| Remembered context given to a run | `RememberedView` | `<details>` list | Keep the disclosure. Label items "From project memory", with dates. | IMPROVE |
| Memory proposals (approve, edit, reject; sensitive confirmation) | `/api/memories/:id/{approve,reject}`; `Proposal` | Works, with correct safeguards | A "Proposed, not saved" visual state distinct from approved memory. Keep the sensitive-content checkbox. | IMPROVE |
| Approved memory: correct, version history, hard delete | `PATCH`/`DELETE /api/memories/:id`, `/history`; `Remembered` | Works; two-step delete | Provenance line (added by you / proposed by a run), dates, a version badge and the history timeline. | IMPROVE |
| Add memory manually | `POST /api/projects/:id/memories` | Inline form | Keep, restyled. | KEEP (behaviour) |
| Decision journal: current decision, revise (keeps old versions), outcomes, review triggers | `/api/projects/:id/decisions`, `/api/decisions/:id/{revise,outcomes}`; `DecisionJournal` | Works; earlier versions in `<details>` | A timeline: original decision → revisions, each with its rationale and date. Outcomes under the version they belong to. "Revisit if" triggers prominent. | IMPROVE |
| Export project data (JSON) | `GET /api/projects/:id/export` | Link at the bottom of the memory panel | Under project settings / data, with an explanation. | IMPROVE |
| Delete project (hard delete) | `DELETE /api/projects/:id` | Two-step inline confirm | Keep two steps, as an accessible confirmation dialog naming the project. | IMPROVE |
| Legal pages and footer | `/privacy`, `/terms`, `SiteFooter` | Fine; draft banner | Restyle with the design system. | KEEP |

### Blocked: no backend capability, so not built here

| Intended experience | Why blocked |
|---|---|
| Document or file upload as evidence | No upload or storage capability exists. |
| Settings / account page (profile, preferences, delete account) | No account settings API. Account deletion is an operator procedure. The account menu shows only email and sign-out, honestly. |
| Global search | No search endpoint. |
| Sharing or printing a brief as a document | No share capability. Browser print can be made to look right with print CSS, which adds no new feature, only presentation. |
| Separate "decisions" inside a project | The data model is project → runs → one active decision version chain. The UI will say "project" and "question", and will not invent a second level. |
| Cross-project "awaiting review" feed from one call | No endpoint lists runs across projects. See risk R3. |
| Notifications, collaboration | Not implemented. |

## 4. Brand gaps found

1. **Palette.** The app uses older colours: ink `#182720`, green `#214b39`, lime `#d5f07a`, paper `#f7f8f3`. The kit specifies Ivory `#FAF9F4`, Ink `#0F202A`, Sage `#7B9B81`, Lime `#D7FF5C` and White. The large dark-green results panel is not part of the brand.
2. **Typography.** The app uses DM Sans and Playfair Display; the brand uses Instrument Sans (wordmark, UI) and Fraunces (tagline, selected display headings). The zip contains no font files; the logo's text is outlined paths.
3. **Logo.** Not used anywhere. Tab icons and app icons are missing.
4. **Tagline.** The app says "Deep thought, with continuity." The brand says **"Think Further."** The hero line "Think beyond the next answer" is product copy, and can stay as a secondary line on sign-in only.

## 5. Proposed design direction

The aim is a calm, editorial, professional thinking environment, using the brand as supplied:
- **Surfaces:** ivory ground, white working surfaces, ink for text and primary actions.
- **Accents:** sage for structure (rules, active states, supportive badges); lime only for one focal highlight at a time (the focus ring or the active stage). Never lime-on-ivory text, because its contrast is too low.
- **Type:** Fraunces only for page titles and the brief's recommendation headline. Instrument Sans for everything else, including all reasoning and evidence text.
- **Information architecture** (one destination per capability, no duplicates):

| Route | What it is |
|---|---|
| `/` | **Overview.** Welcome; "Continue where you left off" (most recently updated projects); briefs awaiting your review; start a new project. |
| `/projects` | **Projects.** All projects, with an archived filter, rename and archive. |
| `/projects/[id]` | **Project workspace.** Problem statement; "Ask a question" (run form); run history; the selected run's progress. Tabs: *Thinking* (runs), *Memory*, *Decision journal*, *Data* (export and delete). |
| `/projects/[id]/runs/[runId]` | **Run.** Progress, then the decision brief with its evidence section, under one deep link. |
| `/login`, `/privacy`, `/terms` | Unchanged routes, restyled. |

  Research and Evidence stays inside the run, which is where the data lives, rather than becoming a separate top-level destination. The app shell has a top bar with the logo, "Overview" and "Projects", plus an account menu. On mobile it collapses to a menu button.
- **States:** every screen gets real loading (skeleton or text), empty (with the next action), error (the API's own message plus retry) and success (notice) states. No invented progress or statistics.

All new pages are client components over the **existing** API calls. No API contract, schema, auth or orchestration change is required for anything above, apart from the optional R3.

## 6. Functionality that must be preserved

- Session-expiry handling: 401 → `/login`. The idempotency key on run creation. Polling stops at settled states.
- Honest labels:
  - demo vs live model, and skipped stages;
  - "not saved until you approve";
  - the sensitive-memory confirmation;
  - two-step hard deletes;
  - failure reasons from `RUN_ERROR_MESSAGES`.
- Evidence links stay `https`-only, opening with `rel="noopener noreferrer nofollow"`. Quotes are shown verbatim.
- Middleware protection of every page except the public routes. The new `/projects…` routes are protected by the existing matcher automatically.
- Security headers and CSP. The CSP gets **tighter**: once fonts are self-hosted, the Google Fonts origins are removed.
- Every existing test, and the legal pages' server rendering.

## 7. Recommended implementation sequence

1. **Design system.**
   - Brand tokens, plus derived contrast tokens where a brand colour fails WCAG AA for its use.
   - Self-hosted Instrument Sans and Fraunces via `@fontsource-variable/*`: free, OFL-1.1, version 5.3.0, no runtime service. This also fixes M8 F10 and tightens the CSP.
   - Logo kit copied into `public/brand/`; favicon and app icons through Next metadata.
   - Base components in `src/app/ui/`: Button, Field, Select, Badge, Notice, EmptyState, Spinner, Dialog, Tabs.
   - Documentation: `docs/ui-ux/DESIGN_SYSTEM.md`.
2. **App shell and sign-in.** Top bar and navigation, account menu, mobile menu, the sign-in screen, and legal page styling.
3. **Primary screens.**
   - Overview, the projects list (rename and archive), and the project workspace with run history (closes **P0-2**).
   - The run page: progress timeline, decision brief document and evidence.
4. **Memory and journal.** Proposal and approved states, provenance, history timeline, decision versions, outcomes, export and delete (with dialogs).
5. **Interaction, accessibility, responsive.** Focus states, keyboard paths, reduced motion, 390 / 768 / 1280 px checks, and print CSS for the brief.
6. **Testing and visual verification.**
   - Render tests for the new components and states, then the full suite.
   - Playwright screenshots of every screen at three widths.
   - `docs/ui-ux/SCREEN_IMPLEMENTATION_REPORT.md`.

Each stage is committed separately, with tests run before the commit, so it can be reviewed on its own.

## 8. Technical risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Splitting the single page into routes could lose state, for example an in-flight run's polling when you navigate away. | The run lives at its own URL and is re-fetched on load, so navigation and reload are both safe. That is the point of P0-2. |
| R2 | The CSP blocks something new (fonts, icons). | Everything is served from `'self'`. The existing `security-headers` test is updated for the stricter font and style sources. Pages are checked for CSP violations in the browser. |
| R3 | "Awaiting review" on the overview needs runs across projects, but no endpoint provides that. | Proposed first: fetch run history for only the few most recently updated projects (at most 5, in parallel) and say "recent projects". The alternative, a read-only `GET /api/runs?status=awaiting_user_review` endpoint, is a backend change and is **not** made without your approval. |
| R4 | `GET /projects/:id/runs` returns full results for up to 50 runs, which is a heavy payload for a list. | Acceptable for the pilot. If it becomes slow, a summary projection is a small backend change, proposed separately. |
| R5 | A real decision brief can't be seen locally without a live model, because the demo worker produces only the scaffold. | Brief screens are checked with a schema-valid fixture inserted into a disposable database for screenshots only, never committed as product data. Render tests use fixtures as well. |
| R6 | Brand lime has low contrast on light grounds. | Lime is used only as a fill behind ink text, or as a focus ring on ink. Contrast ratios are documented in the design system. |
| R7 | Integration test timing flake after a cold database start (§1). | Watch it in CI. Not caused by the UI work. |
