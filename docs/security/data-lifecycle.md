# Data lifecycle: what is stored, export, deletion, retention

_Status as of M3 (2026-10-26). Items marked **open** need a decision before the paid pilot (blueprint §8.2)._

## What Echiche stores

| Data | Where | Contains user content? |
|---|---|---|
| Account (email, auth metadata, sessions) | Supabase Auth (`auth` schema) | Email address |
| Projects (title, problem statement, archived flag) | `echiche.projects` | **Yes**, potentially confidential strategy |
| Thought runs (prompt, structured result, status) | `echiche.thought_runs` | **Yes** |
| Run events (stage names and fixed status messages) | `echiche.run_events` | No (fixed strings today) |
| Stage checkpoints (intermediate stage outputs) | `echiche.run_stage_outputs` | **Yes**: derived from the prompt; deleted with the run |
| Worker liveness (worker ID, version, current run ID) | `echiche.worker_heartbeats` | No |
| Application logs | hosting platform stdout | No: route, event, error code, IDs only (enforced in `log.ts` conventions and tests) |
| Supabase Auth logs | Supabase | Email, IP and user agent (provider-side) |

Every Echiche row carries `owner_user_id`. Only that user can read it (ADR-004).

## Archive vs delete
**Archiving** a project hides it from the default list and blocks new runs. It is **not deletion**; the data remains.

## Deletion
- **Account deletion (available now, operator-run):** deleting the user in Supabase Auth (dashboard, or the Admin API with the service-role key, which is never used by the app) removes `auth.users`. That cascades to **all** of their projects, runs and events (foreign keys `on delete cascade`, covered by the integration test "cascades an account deletion").
- **User-initiated project/account deletion in the app:** **not yet** (M6). End users have no DELETE privilege until then.
- **Backups:** deleted rows persist in Supabase backups until those backups expire. **Open:** confirm the backup retention window for the chosen plan and state it in the privacy notice.

## Export (EXPORT-01)
**Not yet implemented (M6).** Interim: an operator can export a user's rows with SQL filtered by `owner_user_id`, on request.

## Retention (open)
No automatic expiry exists yet. Decide before the pilot:
- retention for inactive accounts;
- retention for archived projects;
- log retention on the hosting platform and in Supabase;
- what the privacy notice promises.
