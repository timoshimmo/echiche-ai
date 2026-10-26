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

4. **Point Supabase at the app:** in Supabase Auth URL settings, set the Site URL to `APP_ORIGIN` and add `<APP_ORIGIN>/auth/callback` to the redirect URLs.
5. **Workspace plan:** Hobby (free) workspace is fine to start. Upgrade to Pro ($25 flat) for preview environments; then set `previews` in `render.yaml`.

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

## Scaling and shutdown
- **More throughput:** increase the worker's instance count. Claims are safe under concurrency (`SKIP LOCKED` plus leases), and each instance gets a unique `WORKER_ID` from its hostname.
- **During deploys:** Render sends SIGTERM. The worker finishes its current stage and releases the run without consuming an attempt; another instance or the new version continues it. `maxShutdownDelaySeconds: 120` must stay above `WORKER_STAGE_TIMEOUT_SECONDS: 90`.

## Rollback
Use Render's **Rollback** on a service. Database changes are forward-only: if a migration is the problem, ship a new corrective migration (never edit an applied one).
