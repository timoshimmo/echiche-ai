# Runbook: deploying to Render (Frankfurt)

ADR-005 hosting, ADR-006 runs. First complete [supabase-setup.md](supabase-setup.md) for the same environment, in Supabase region `eu-central-1`.

## One-time setup
1. **Prerequisites:** push the repository to GitHub, and confirm the latest CI run is green.
2. **Create the Blueprint:** in Render, choose **New → Blueprint** and select the repo. Render reads `render.yaml` and proposes:
   - **`echiche-web`:** Node, Frankfurt, 1 CPU / 2 GB, health check `/api/ready`
   - **`echiche-worker`:** Docker Background Worker, Frankfurt, 0.5 CPU / 512 MB
3. **Enter the secrets Render prompts for** (only on first creation):

   | Service | Variable | Value |
   |---|---|---|
   | web | `DATABASE_URL` | Supabase pooler URL as **`echiche_web.<project-ref>`** (transaction mode, port 6543) |
   | web | `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
   | web | `SUPABASE_PUBLISHABLE_KEY` | publishable (anon) key, **never** the secret/service-role key |
   | web | `APP_ORIGIN` | `https://echiche-web.onrender.com`, or your custom domain once attached |
   | worker | `DATABASE_URL` | Supabase pooler URL as **`echiche_worker.<project-ref>`** |
   | worker | `OPENAI_API_KEY` | Leave **empty** until you enable live reasoning (below). Never set it on the web service: it refuses to start. |
   | worker | `BRAVE_SEARCH_API_KEY` | Leave **empty** until you enable research (below). |

4. **Point Supabase at the app:** in Supabase Auth URL settings, set the Site URL to `APP_ORIGIN` and add `<APP_ORIGIN>/auth/callback` to the redirect URLs.
5. **Workspace plan:** Hobby (free) workspace is fine to start. Upgrade to Pro ($25 flat) for preview environments; then set `previews` in `render.yaml`.
6. **Service plans (cost):** `render.yaml` puts the web app on `free` and the worker on Starter (`0.5c-512mb`, $7/month; workers have no free plan). That's $7/month in total. A free web service sleeps after 15 minutes idle (the next request takes about a minute) and runs on 0.1 CPU. Before inviting partners, change the web plan to `0.5c-512mb` ($7) or `1c-2g` ($25). Prices as of 2026-10-28; check Render's pricing page.

## Every deploy (migrations first)
Migrations are deliberately **not** run by Render: that would put admin DB credentials in the web service's environment.

```bash
# From a reviewed commit, on your machine:
npx supabase link --project-ref <project-ref>
npx supabase db push        # review the pending list, confirm
```

Then merge to the deploy branch; Render builds and deploys both services.

Write migrations to be backward compatible with the currently running code (add before remove), because the old web app and worker keep running briefly during rollout.

## After deploy: smoke test
1. `GET /api/ready` returns 200.
2. In the worker logs, a `worker_connected` line appears, and `echiche.worker_heartbeats` has one row per worker instance.
3. Sign in, create a project, start a run: the UI moves through the stages to "Ready for review", then Accept works.
4. With a second account, the first account's run returns 404.
5. The result is labelled **Demo mode** until live reasoning is enabled, then **Live model (OpenAI · …)**.

## Enabling live reasoning (OpenAI, ADR-007)
Paid calls start only after these steps; until then the worker runs the deterministic demo mode.
1. ADR-007 D9–D12 were approved on 2026-10-26. Before real users, update the privacy notice: project and question text are sent to OpenAI (not used for training by default; abuse-monitoring logs up to 30 days; `store=false`).
2. In OpenAI, create a **project-scoped key** with a monthly budget limit. For EU data residency, get OpenAI's approval first, then set `OPENAI_DATA_RESIDENCY=eu` (+10% price).
3. On **`echiche-worker`** only: set `OPENAI_API_KEY` (secret), then set `REASONING_PROVIDER=openai`. Optionally change `OPENAI_MODEL` to another priced model (`gpt-6-luna` is cheapest). An unpriced model makes the worker exit at start-up with `config_invalid`.
4. Check the worker's start-up log: `worker_starting` with `"provider":"openai:<model>"`. A bad key shows up as runs failing with `PROVIDER_AUTH`.
5. Optional, from your machine: run the one-call live smoke test (`cd worker && ECHICHE_LIVE_OPENAI=1 OPENAI_API_KEY=… uv run pytest -m live -s`, cost < $0.05).

**To switch back** to demo mode, set `REASONING_PROVIDER=deterministic`. Runs already in progress with model checkpoints then fail with `REASONING_MODE_MISMATCH`; start them again.

## Enabling research (Brave, ADR-008)
Research requires live reasoning (above).
1. **Licensing:** before real users, get Brave's written confirmation that the plan you choose allows using search results transiently to find pages, and confirm you are comfortable keeping short excerpts of publisher pages (at most 3 × 500 characters per source, robots.txt and `noarchive`/`noai` honoured). This is a licensing question, not legal advice.
2. **Key:** in the Brave Search API dashboard, create a key on the Search plan ($5 per 1,000 searches; $5 free credit each month, as of 2026-10-28). Set a spend limit there if available.
3. **Worker settings:** on **`echiche-worker`** only, set `BRAVE_SEARCH_API_KEY`, then `RESEARCH_PROVIDER=brave`. The defaults allow 3 searches and keep at most 6 sources per run; each run's search budget (`RUN_BUDGET_MAX_RESEARCH_CALLS` on the web service, default 8) also caps searches.
4. **Check:** the start-up log shows `"provider":"openai:<model>+brave"`. A rejected key fails runs with `RESEARCH_AUTH`.
5. **Optional smoke test:** run the live research test from your machine (`cd worker && ECHICHE_LIVE_BRAVE=1 BRAVE_SEARCH_API_KEY=… uv run pytest -m live -s -k research`).

The worker fetches pages from the public web as `EchicheResearchBot/<version>`. Render's outbound network needs no extra configuration.

## Scaling and shutdown
- **More throughput:** increase the worker's instance count. Claims are safe under concurrency (`SKIP LOCKED` plus leases), and each instance gets a unique `WORKER_ID` from its hostname.
- **During deploys:** Render sends SIGTERM. The worker finishes its current stage and releases the run without consuming an attempt; another instance or the new version continues it. `maxShutdownDelaySeconds: 120` must stay above `WORKER_STAGE_TIMEOUT_SECONDS: 110`.

## Rollback
Use Render's **Rollback** on a service. Database changes are forward-only: if a migration is the problem, ship a new corrective migration (never edit an applied one).
