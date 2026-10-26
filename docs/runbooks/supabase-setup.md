# Runbook: Supabase environment setup (staging first)

The manual, per-environment steps that code cannot do. Do them in **staging** before production. Dashboard menu names can shift between Supabase releases; the setting names are what matter.

## 1. Create the project
- Region: **Frankfurt (`eu-central-1`)**, the same region as the Render services (ADR-005). Supabase regions can't be changed later.
- Check Supabase's current data-processing terms for that region before storing real founder data.
- Save the database password in a password manager. **Never paste it into chat, issues or commits.**

## 2. Apply migrations (from a reviewed commit)
```bash
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase db push            # shows pending migrations; confirm
```
Migration 0003 creates the roles `echiche_end_user`, `echiche_web` and `echiche_worker` (all NOLOGIN) and moves tables into the private `echiche` schema.

## 3. Give the app roles passwords (SQL editor, once per environment)
Generate two long random passwords (e.g. `openssl rand -base64 32 | tr -d '/+='`), then:
```sql
alter role echiche_web    with login password '<generated-web-password>';
alter role echiche_worker with login password '<generated-worker-password>';   -- needed from M3
```
Store them in the hosting platform's secret manager only. Rotate the same way if exposed.

## 4. Connection strings
- **Web app** `DATABASE_URL`: connect **as `echiche_web`**, never as `postgres` and never with a service-role key.
  - With Supabase's connection pooler the username takes the form `echiche_web.<project-ref>`. The app sets `prepare: false`, so transaction-mode pooling is supported.
  - **Verify on staging** that the pooler accepts the custom role: `curl https://<app>/api/ready` should return `{"status":"ready"}`.
- **Worker** (M3): the same, as `echiche_worker`.

## 5. Auth settings (Authentication → URL configuration / Providers / Rate limits)
| Setting | Value |
|---|---|
| Site URL | your `APP_ORIGIN`, e.g. `https://app.example.com` |
| Redirect URLs | `<APP_ORIGIN>/auth/callback` (exact; no wildcards in production) |
| Email provider | enabled; magic link / OTP expiry **900 s** |
| Sign-ups | **Recommended for the private pilot: disabled.** Invite design partners from the Users page instead. (Sign-in does not reveal whether an address has an account.) |
| SMTP | **Custom SMTP is required before real users**: the built-in sender is for testing and heavily rate-limited. Choosing a provider is a paid-service decision. |
| Rate limits | keep email-send limits low (e.g. a few per hour per address) |

## 6. Keep the Data API away from Echiche data
- **API settings → Exposed schemas:** must **not** include `echiche`. The default (`public`, `graphql_public`) is correct.
- Echiche does not use the Data API. Disabling it entirely is an extra safeguard if nothing else in the project needs it.

## 7. Web app environment
| Variable | Value |
|---|---|
| `DATABASE_URL` | `echiche_web` connection string (step 4) |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | the **publishable** (or legacy anon) key |
| `APP_ORIGIN` | exact https origin of the app |
| `PROJECT_CREATE_LIMIT_PER_HOUR`, `RUN_CREATE_LIMIT_PER_HOUR` | optional (defaults 30 / 20) |

**Never set** `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_SECRET_KEY` in the web app. The server refuses to start if present. Some hosting integrations add it automatically, so remove it.

## 8. Smoke test after each deploy
1. `GET /api/health` returns 200.
2. `GET /api/ready` returns 200 `{"status":"ready"}`.
3. Sign in with an invited address: the email arrives, the link lands you on `/`, and your email shows top right.
4. Create a project and run it.
5. Sign out; reloading `/` redirects to `/login`.
6. With a second invited account: the first account's project is not listed, and opening its `/api/projects/<id>` returns 404.

## Upgrading a local database from M1
M1 migrated with the deleted `scripts/migrate.mjs`. Either recreate the database with `npm run db:reset`, or keep it:
```bash
npx supabase migration repair --status applied 0001 0002 --db-url <url>
psql <url> -c "truncate projects cascade"   # dev data only: 0003 refuses pre-auth rows
npx supabase migration up --db-url <url>
```
