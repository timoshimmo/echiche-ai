# Screen implementation report (UI/UX phase)

- **Date:** 2026-10-29
- **Commits:** `f778890` (Stage 1 audit), `21ce5f7` (Stage 2 design system), `e4c9a00` (Stage 3 shell and sign-in), `1ea1c10` (Stages 4–5 screens), and this commit (Stages 6–7: error boundary, not-found page, accessibility and visual verification).
- **Related documents:**
  - [PRODUCT_EXPERIENCE_AUDIT.md](PRODUCT_EXPERIENCE_AUDIT.md): the baseline and the plan.
  - [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md): tokens and components.

No API contract, database schema, auth flow, worker or AI orchestration code was changed. The redesign uses the existing endpoints only. The one security-relevant change makes things **stricter**: the CSP no longer allows Google Fonts.

## 1. Test results (actual output, 2026-10-29)

```
## npm test
 Test Files  14 passed (14)
      Tests  124 passed (124)        (baseline: 108; +16 new UI tests)
## typecheck
clean
## lint
0                                     (lines of lint output)
## integration                         (Postgres 16, migrated; web + real Python worker)
 Test Files  5 passed (5)
      Tests  54 passed (54)
## worker unit
165 passed, 50 deselected
## worker integration
48 passed, 167 deselected
## build
 ✓ Compiled successfully
+ First Load JS shared by all              103 kB
## audit
found 0 vulnerabilities
scan-secrets: 263 tracked files, no credentials found
```

**GitHub CI** passed on `1ea1c10`: all 4 jobs, including the real local Supabase stack. The Stage 3 commit's run failed in `npx supabase start`, before any test ran. That commit made no Supabase or test change, and the next run passed.

### New frontend tests

| File | What it covers |
|---|---|
| `src/app/ui/primitives.test.ts` | Logo uses the supplied files; alert vs status roles; field label, hint and error wiring; tabs ARIA; the confirm dialog names its action; decorative images are hidden. |
| `src/app/lib/run-display.test.ts` | Stage states from real run fields (done / active / skipped); the plain-language routing summary; "needs attention"; relative dates; calendar dates are not shifted by time zone. |
| `src/app/decision-brief.test.ts` | The recommendation comes first; source links are safe (`noopener noreferrer nofollow`); only sources that were actually read are linked; the labels disclaimer; the demo scaffold is never presented as a brief. |
| `src/app/legal-pages.test.ts` | Extended: brand assets and icons are public; new app routes are protected. |
| `src/lib/server/security-headers.test.ts` | Extended: fonts, styles and images load from this origin only; no Google origins. |

### Browser verification
These checks used Playwright against a production build (`next start`), the real Python worker in demo mode, and a disposable database. The scripts live in the session scratchpad, not in the repository; see §7.

| Check | Result |
|---|---|
| Interactive walkthrough: every control on the new screens | **7 of 7 flows passed, no console errors** (listed below) |
| axe-core 4.10 (WCAG 2.0/2.1 A and AA rules), 12 screens × 2 widths, all disclosures opened | **0 violations** |
| Horizontal overflow at 1280, 768 and 390 px, 11 screens | **none** |
| CSP violations or console errors while touring the screens | **none** |

The keyboard focus order follows the visual order: skip link → logo → navigation → account → page actions → tabs → list rows. Every element showed a 2 px focus outline.

The seven walkthrough flows:
1. Create a project.
2. Start a quick run, then mark the demo result as reviewed.
3. Accept a brief, then record an outcome and revise the decision.
4. Memory: approve, search and clear, correct with history, add, cancel a delete with Esc, then delete through the dialog.
5. Keyboard tabs and the account menu.
6. Archive (which disables runs), restore, rename, then delete through the dialog.
7. Not-found pages for a project and a run.

## 2. Screen by screen

### Sign-in (`/login`)
- **Improved:**
  - A brand panel (ink, colour-dark tagline lockup) explains Echiche in three plain steps.
  - A focused form with a labelled field, a hint, and inline error and "sent" notices.
  - On mobile, the logo and a one-line explanation sit above the form.
- **Why:** The old page reused the marketing hero, showed no logo, and did not explain the product.
- **Uses:** The existing `POST /auth/sign-in` form and the same error codes and messages. No password field: sign-in is by magic link.
- **Incomplete:** None.

### App shell (all signed-in screens)
- **Improved:**
  - A sticky header with the logo; Overview and Projects marked with `aria-current`.
  - An account menu with the email and Sign out; it closes with Esc or a click outside.
  - A skip link and a shared footer. Phones get the compact symbol logo.
- **Why:** The app had no navigation; everything lived on one page.
- **Uses:** `GET /api/me` and `POST /auth/sign-out`.
- **Incomplete:** No settings page. There is no account API (see §5).

### Overview (`/`)
- **Improved:** It answers "What needs me?", "What is in progress?" and "Where did I leave off?". First-time users get a three-step explanation and one call to action. No invented statistics.
- **Why:** This was the first design priority, "dashboard must establish confidence".
- **Uses:** `GET /api/projects`, plus `GET /api/projects/:id/runs` for the 5 most recently updated projects.
- **Incomplete:** "Needs your attention" covers only those 5 projects, and the page says so. No endpoint lists runs across projects (audit R3); adding one is a backend change that needs approval.

### Projects (`/projects`) and new project (`/projects/new`)
- **Improved:**
  - Active and Archived tabs with counts.
  - Rows show the title, purpose and last update.
  - Empty states with the next action.
  - A creation page with guidance and an example *placeholder*; no fabricated projects.
- **Why:** The old list sat under an always-open form, with no dates or status.
- **Uses:** `GET /api/projects?includeArchived=true` and `POST /api/projects`.
- **Incomplete:** None.

### Project workspace (`/projects/:id`)
- **Improved:**
  - The header shows the title, problem statement and dates, with **Edit project**: rename and edit the problem statement. This was missing before.
  - Four tabs, kept in the URL: **Thinking** (ask plus run history), **Memory**, **Decision journal**, **Data and settings**.
  - The ask form explains what a run does and keeps the depth choice and its hints.
  - It blocks a second run while one is active (with a link to it) and explains why runs are off in an archived project.
- **Why:**
  - Run history was readiness item **P0-2**: briefs were lost on reload.
  - Rename and archive existed in the API with no UI.
- **Uses:**
  - `GET/PATCH /api/projects/:id`
  - `GET/POST /api/projects/:id/runs`, with the idempotency key kept
  - `GET /api/projects/:id/memories?status=proposed` (for the "to review" count)
- **Incomplete:** The history shows the latest 50 runs, which is the API limit.

### Run page and decision brief (`/projects/:id/runs/:runId`)

**Run page:**
- **Improved:**
  - Each run has its own link.
  - A stage timeline: done / active (moving lime marker) / skipped / to do, driven only by `completedStages` and `status`. A polite live region announces stage changes.
  - A plain-language routing sentence, with the raw reasons in a disclosure.
  - Failure and pause reasons come from `RUN_ERROR_MESSAGES`.
  - Cancel asks for confirmation.
  - "Approve more budget" says it counts against the daily limit.
  - After the brief, a **Ready to decide?** bar.
- **Why:** This was the second design priority, "reasoning workspace as signature experience". There is no invented progress.

**Brief:**
- **Improved:**
  - Recommendation and confidence come first. The summary is set in Fraunces, followed by the rationale and "Why this confidence".
  - The sections, in order:
    1. The decision and its scope
    2. Key assumptions (epistemic label plus confidence)
    3. Evidence for and against, with source chips that jump to the verified source; strongest objection
    4. Alternatives
    5. Trade-offs
    6. What would change it
    7. Next steps (success signal, reversible)
    8. Limitations
    9. Proposed memory, with a link to Memory
    10. **Sources and verification**: counts, each quote with its verdict badge, stale and contradiction badges, read-but-not-cited, failed claims
    11. The memory the run was given
  - A contents rail on wide screens. Print styles.
- **Why:**
  - This was the third design priority, "the decision brief must demonstrate value".
  - Evidence must separate verified claims, model labels and failures. The page states that labels are the model's own assessment.

**Demo scaffold:**
- **Improved:** The fixed demo template is labelled **"Starter structure, not a decision brief"** in dashed cards. Its accept button reads **Mark as reviewed** and says no decision is recorded.
- **Why:** The old page called it "DECISION BRIEF". Staging currently produces this output, because it has no OpenAI key.

- **Uses:** `GET /api/runs/:id` (polling until settled), `POST /api/runs/:id/{cancel,resume,accept}`, and run evidence and remembered context.
- **Incomplete:** None in the UI. A real model brief can only be produced with a live model (P0-5). Brief screens were verified with a schema-valid **fixture** (§6).

### Memory (Memory tab)
- **Improved:**
  - Proposals ("Proposed · not saved", dashed amber) are visually separate from remembered items.
  - Each item shows its kind tag (assumptions dashed, open questions in the warning style; never shown as fact), "Remembered since" date, and provenance (added by you / proposed by a run and approved / edited / corrected, linked to the source run).
  - Correction keeps a version history; delete goes through a confirmation dialog.
  - **Search and kind filter** use the existing `?q=` and `?kind=` API parameters.
  - Adding your own item is a labelled form.
- **Why:** Memory should be visible and under the user's control. The old list was dense and had no search.
- **Uses:**
  - `/api/projects/:id/memories` (GET with status, q and kind; POST)
  - `/api/memories/:id` (PATCH, DELETE)
  - `/approve`, `/reject` and `/history`
  - The sensitive-content confirmation is unchanged.
- **Incomplete:** None.

### Decision journal (Journal tab)
- **Improved:**
  - The current decision card shows its version, origin (linked to the brief's run), date and confidence, then the question, the choice (display type) and the rationale.
  - **Revisit this decision if** triggers.
  - Outcomes with result badges, and a labelled form to record one.
  - Revising states which version it creates.
  - **Earlier versions** appear as a timeline, the first labelled "Original decision", each with its own rationale and outcomes.
- **Why:** Earlier versions must stay readable after a revision, with their original rationale.
- **Uses:** `/api/projects/:id/decisions` and `/api/decisions/:id/{revise,outcomes}`.
- **Incomplete:** None.

### Data and settings (tab)
- **Improved:** Export (JSON download), archive or restore, and delete. Each says what it does. Delete is a danger-zone card with a dialog that names the project.
- **Why:** These controls were at the bottom of the memory panel, with an inline two-step delete.
- **Uses:** `GET /api/projects/:id/export`, `PATCH {archived}` and `DELETE /api/projects/:id`.
- **Incomplete:** None.

### Privacy, terms and not-found
- **Improved:** A public header with the logo, reading-width typography and the draft banner as a warning notice. A branded 404 page.
- **Uses:** The same content as before.
- **Incomplete:** The legal text is still a draft for legal review (P0-1).

### Error boundary
A rendering failure on a signed-in screen shows a recovery state (Try again / Go to the overview) with the support address. It never shows a blank page or the raw error.

## 3. Existing features preserved

| Area | What still works |
|---|---|
| Sign-in | Magic-link sign-in with every error message; the browser-binding marker; sign-out |
| Session | Expiry handling: any 401 goes to `/login` |
| Projects | Create; list (archived hidden by default) |
| Runs | The idempotency key on run creation; depth selection with hints; routing transparency (tier, reasons, policy version, escalation) |
| Run progress | Polling every 1.5 s until settled; cancel, resume after a budget pause, accept |
| Labels | Generation labels (live model vs demo) and call telemetry; failure reasons from `RUN_ERROR_MESSAGES` |
| Briefs and evidence | Every decision-brief field; sources, verified quotes, verdicts, stale and contradiction flags, uncited sources, failed claims; https-only links with `noopener noreferrer nofollow` |
| Memory | The remembered context given to a run; approve (with edit), reject, sensitive confirmation, correct with history, hard delete of all versions, add |
| Journal | Accepting a brief records a decision; revise (new version); outcomes |
| Data | Project export; hard project delete |
| Legal and support | Legal pages, the pilot and "not professional advice" notice, the support contacts on every page |
| Security | Security headers (CSP now stricter); middleware protection of every non-public page |

## 4. UI improvements implemented
- **Brand:**
  - Brand tokens with documented contrast.
  - Instrument Sans and Fraunces, self-hosted (this fixes M8 F10).
  - The real logo, favicon and app icon.
  - The tagline "Think Further."
- **Navigation and pages:**
  - Shared app shell, account menu and skip link.
  - Seven signed-in routes in place of one page.
- **Overview:** attention, in-progress and recent work; first-time onboarding.
- **Projects:** rename, edit the problem statement, archive and restore. All existed in the API with no UI.
- **Runs:** run history and deep links (P0-2); the stage timeline; plain routing text; the decide bar.
- **Brief and evidence:** the brief as a document with contents and print styles; evidence with verdict badges and source anchors; an honest demo-scaffold label and accept wording.
- **Memory:** search and kind filter; provenance; a version-history view.
- **Journal:** a timeline that keeps the original decision.
- **Confirmations:** dialogs for delete memory, delete project and cancel run.
- **States:** consistent empty, loading (skeleton), error (with retry) and not-found states; an error boundary.
- **Accessibility:** labelled fields with hints and errors linked; ARIA tabs with keyboard support; reduced motion; 44 px touch targets; responsive layouts at 1280, 768 and 390 px.

## 5. Limitations deliberately left untouched

| Limitation | Reason |
|---|---|
| No document upload, global search, sharing, notifications or collaboration | These capabilities do not exist (audit §3, BLOCKED) |
| No settings or account page; no in-app account deletion | No account API exists; account deletion is an operator procedure. The account menu shows the email and sign-out only. |
| "Needs your attention" checks the 5 most recent projects | No cross-project runs endpoint (R3). A read-only endpoint is proposed, pending approval. |
| The run list loads full results for up to 50 runs | Acceptable for the pilot (R4). A summary projection would be a backend change. |
| Real briefs need a live model | Staging has no OpenAI key, so it shows the labelled demo scaffold (P0-5). |
| Legal pages remain drafts | They need legal review (P0-1). |
| The social preview image is shipped but not wired into metadata | Wiring it needs a fixed public `metadataBase`. The pilot is also marked `noindex`. |
| The Playwright walkthrough is not in CI | It needs a fake auth server and a running worker. Making it a CI job is a sensible follow-up. |

## 6. Visual review: findings and fixes
**Verification data:**
- Every screen was reviewed in the rendered production build at 1280, 768 and 390 px.
- Brief screens used a **fixture**: a schema-valid decision brief inserted into the disposable database. Its provider is literally `fixture`, its model `fixture-model`, and its sources are `example.org`, `example.com` and `example.net` pages titled "(fixture source)".
- The fixture was never committed as product data, and screenshots with it cannot pass for real output.
- Other data was typed in through the UI.

| Found during review | Fix |
|---|---|
| Login logo stretched to the centre of the brand panel | `align-self: flex-start` |
| Mobile login had no explanation and no `h1` | One-line intro on mobile; "Sign in" is the `h1` |
| Hero letter-spacing too tight in Instrument Sans | The hero was removed; display type is Fraunces with tuned tracking |
| A demo result was labelled "Review the brief" and "Accept brief" | Now "Review the result" and "Mark as reviewed", with a note that no decision is recorded (the server records decisions only for real briefs) |
| Nested outcome items in the journal timeline inherited the timeline's dot and grid | Selectors scoped to `.timeline-v > li` |
| Timeline stage names collided at 390 px | Smaller labels; descriptions hidden on phones |
| Anonymous pages prefetched `/`, which redirects to sign-in | `prefetch={false}` on the public logo link |
| The accept action sat above a long brief | Added a "Ready to decide?" bar after the brief |
| Cancel dialog had two buttons that both said "Cancel" | `cancelLabel="Keep running"` |

## 7. Screenshots and how they were made
WebP screenshots are in [`screenshots/`](screenshots/). They are full page, at desktop width unless the name says tablet or mobile.

| Screen | Files |
|---|---|
| Sign-in | `01-sign-in-*`, including the error state |
| Overview | `02-overview-*`: first-time, populated, loading, mobile |
| Projects | `03-projects-*`, including a network-error state |
| New project | `04-new-project-desktop` |
| Workspace | `05-workspace-*`, desktop and tablet |
| Run page | `06-run-brief-*` (fixture brief), `06-run-demo-scaffold-desktop` |
| Memory | `07-memory-*` |
| Journal | `08-journal-desktop` |
| Data and settings | `09-data-and-settings-desktop` |
| Other | `10-privacy-desktop`, `11-account-menu-desktop` |

**How they were made:**
- **Data:** a disposable database (`ui_base`) migrated with `npm run test:db:prepare`.
- **Server:** `next start` with `NODE_ENV=production`, the M8 fake Supabase Auth server for sign-in cookies, and the Python worker in demo mode.
- **Origin proxy:** a local proxy rewrites `Origin` to the https `APP_ORIGIN` that production config requires.
- **Capture:** Playwright for the screenshots, the walkthrough, the overflow checks and axe-core.
