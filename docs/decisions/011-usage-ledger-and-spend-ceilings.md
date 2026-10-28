# ADR-011: Usage ledger and spend ceilings

- Status: **Accepted** (2026-10-28). The decision owner approved pilot ceilings of $2 per user and $15 across all users per rolling 24 hours.
- Date: 2026-10-28
- Decision owner: Tokmang
- Related: [M8 security review](../security/review-m8.md), finding F1; ADR-006 (budgets); ADR-009 (hard delete)

## Context
Hourly creation limits counted rows in `projects` and `thought_runs`. ADR-009 made project deletion a hard delete that cascades to runs and their `model_calls`, so deleting and recreating reset the limits and erased the spend record. Separately, nothing bounded what one user, or all users together, could spend in a day. The only bound was each run's own cap.

## Decision
1. **`echiche.usage_ledger`** (migration 0009).
   - **What it holds:** one append-only row per rate-limited action (project, run, resume, export, journal write), with its reserved spend and a timestamp. No project ID and no content.
   - **Who can touch it:** owners insert and read their own rows under RLS; nobody updates or deletes through the app.
   - **Deletion:** it is removed with the account (cascade from `auth.users`), not with a project.
2. **Hourly limits** for projects, runs, exports and journal writes count ledger rows, serialised per owner and kind with advisory locks.
3. **Spend ceilings over a rolling 24 hours**, per user and across all users.
   - **What counts:** a new run reserves its full tier spend cap, and a resume reserves its increment. Actual spend can only be lower, so the ceiling is a hard upper bound without the web app tracking live spend.
   - **How the global check works:** the global total is read through `echiche.global_reserved_spend(interval)`, a `SECURITY DEFINER` function that returns one number, under a single advisory lock.
   - **What the user gets:** `429 SPEND_LIMIT_REACHED`.
4. **Configuration (web):**

   | Variable | Default |
   |---|---|
   | `USER_DAILY_SPEND_LIMIT_USD` | 2 (pilot) |
   | `GLOBAL_DAILY_SPEND_LIMIT_USD` | 15 (pilot) |
   | `EXPORT_LIMIT_PER_HOUR` | 10 |
   | `JOURNAL_WRITE_LIMIT_PER_HOUR` | 300 |

   Start-up fails if the user ceiling is below one run's cap, or if the global ceiling is below the user ceiling.

## Consequences
- **Over-counting:** reservations over-count, so a cancelled or cheap run holds its full cap for 24 hours. This is safe and simple; refunding unspent reservations would need the worker to write to the ledger, and is deferred until real usage shows it's needed.
- **Availability:** the global ceiling protects cost, not availability. One abuser can use up the day's budget for everyone, so open sign-up still needs the Auth-level controls in the review's follow-ups.
- **Retention:** the ledger is pseudonymous metadata kept after project deletion. The data lifecycle documents it, and the operator deletes rows older than 30 days.
- **Alternatives rejected:**
  - A soft delete for projects: it would reverse ADR-009's hard-delete choice.
  - Counting `model_calls`: they cascade too, and they only exist after the money is spent.
  - Per-IP limits in the app: these belong at the edge.
