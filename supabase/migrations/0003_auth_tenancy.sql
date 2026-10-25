-- M2: authentication, tenant ownership, least-privilege roles and row-level security.
-- See docs/decisions/004-auth-and-tenancy.md for the layering this implements.
--
-- Requires Supabase's auth.users table (present in every Supabase project and in
-- `supabase start`). Login passwords for echiche_web / echiche_worker are NEVER set
-- here; they are set once per environment, out of band (docs/runbooks/supabase-setup.md).

-- ---------------------------------------------------------------------------
-- 0. Refuse to invent owners for pre-auth rows.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.projects) then
    raise exception using
      message = 'Migration 0003 requires an empty projects table: rows created before auth have no owner.',
      hint = 'Development data only: export what you need, then TRUNCATE projects CASCADE and re-run. See docs/runbooks/supabase-setup.md.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Private schema. Supabase's Data API exposes only the schemas listed in its API
--    settings (public, graphql_public by default), so tables here are unreachable
--    with the public publishable/anon key even before grants and RLS are considered.
-- ---------------------------------------------------------------------------
create schema if not exists echiche;
revoke all on schema echiche from public;

alter table public.projects set schema echiche;
alter table public.thought_runs set schema echiche;
alter table public.run_events set schema echiche;

-- ---------------------------------------------------------------------------
-- 2. Ownership. owner_user_id is denormalised onto child rows and tied to the parent
--    with composite foreign keys, so a child can never point at another user's parent.
-- ---------------------------------------------------------------------------
alter table echiche.projects
  add column owner_user_id uuid not null references auth.users (id) on delete cascade,
  add column archived_at timestamptz,
  add column updated_at timestamptz not null default now(),
  add constraint projects_id_owner_key unique (id, owner_user_id);

alter table echiche.thought_runs
  add column owner_user_id uuid not null,
  drop constraint thought_runs_project_id_fkey,
  add constraint thought_runs_project_owner_fkey
    foreign key (project_id, owner_user_id) references echiche.projects (id, owner_user_id) on delete cascade,
  add constraint thought_runs_id_owner_key unique (id, owner_user_id);

alter table echiche.run_events
  add column owner_user_id uuid not null,
  drop constraint run_events_run_id_fkey,
  add constraint run_events_run_owner_fkey
    foreign key (run_id, owner_user_id) references echiche.thought_runs (id, owner_user_id) on delete cascade;

drop index if exists echiche.projects_created_at_idx;
create index projects_owner_created_idx on echiche.projects (owner_user_id, created_at desc);
create index thought_runs_owner_created_idx on echiche.thought_runs (owner_user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. Identity for policies. Reads the claims the web app sets per transaction
--    (set_config('request.jwt.claims', ..., true)). Returns NULL when unset, which
--    matches no rows. Deliberately independent of Supabase's auth.uid() so the
--    policies do not depend on privileges in the auth schema.
-- ---------------------------------------------------------------------------
create or replace function echiche.current_user_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
$$;
revoke all on function echiche.current_user_id() from public;

-- ---------------------------------------------------------------------------
-- 4. Roles (ADR-001 D5). All NOLOGIN here; LOGIN + password are set out of band.
--    echiche_end_user  - what a signed-in user's request runs as (via SET LOCAL ROLE)
--    echiche_web       - the web app's connection role; NOINHERIT, so it has no table
--                        privileges until it switches to echiche_end_user
--    echiche_worker    - the Python worker (M3); processes runs for all owners
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'echiche_end_user') then
    create role echiche_end_user nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'echiche_web') then
    create role echiche_web nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'echiche_worker') then
    create role echiche_worker nologin noinherit;
  end if;
end $$;

grant echiche_end_user to echiche_web;

grant usage on schema echiche to echiche_end_user, echiche_worker;
grant execute on function echiche.current_user_id() to echiche_end_user, echiche_worker;

-- Remove whatever the tables carried over from public (Supabase grants anon,
-- authenticated and service_role ALL on public tables by default).
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema echiche from %I', r);
      execute format('revoke all on schema echiche from %I', r);
    end if;
  end loop;
end $$;
revoke all on all tables in schema echiche from public;

-- End-user privileges: column-scoped, no DELETE anywhere yet (deletion arrives with
-- export/delete in M6). thought_runs UPDATE exists only because runs still execute
-- synchronously in the web request; M3 moves it to echiche_worker and revokes it here.
grant select on echiche.projects, echiche.thought_runs, echiche.run_events to echiche_end_user;
grant insert (owner_user_id, title, problem_statement) on echiche.projects to echiche_end_user;
grant update (title, problem_statement, archived_at, updated_at) on echiche.projects to echiche_end_user;
grant insert (owner_user_id, project_id, prompt, status) on echiche.thought_runs to echiche_end_user;
grant update (status, result, result_schema_version, error_code, completed_at) on echiche.thought_runs to echiche_end_user;
grant insert (owner_user_id, run_id, sequence, event_type, stage, message) on echiche.run_events to echiche_end_user;

-- Worker privileges (used from M3): read everything it processes, write execution facts only.
grant select on echiche.projects, echiche.thought_runs, echiche.run_events to echiche_worker;
grant update (status, result, result_schema_version, error_code, completed_at) on echiche.thought_runs to echiche_worker;
grant insert (owner_user_id, run_id, sequence, event_type, stage, message) on echiche.run_events to echiche_worker;

-- ---------------------------------------------------------------------------
-- 5. Row-level security. FORCE applies policies to the table owner too; only
--    superusers / BYPASSRLS roles (migrations, operators) skip them.
-- ---------------------------------------------------------------------------
alter table echiche.projects enable row level security;
alter table echiche.projects force row level security;
alter table echiche.thought_runs enable row level security;
alter table echiche.thought_runs force row level security;
alter table echiche.run_events enable row level security;
alter table echiche.run_events force row level security;

create policy projects_owner_select on echiche.projects for select to echiche_end_user
  using (owner_user_id = echiche.current_user_id());
create policy projects_owner_insert on echiche.projects for insert to echiche_end_user
  with check (owner_user_id = echiche.current_user_id());
create policy projects_owner_update on echiche.projects for update to echiche_end_user
  using (owner_user_id = echiche.current_user_id())
  with check (owner_user_id = echiche.current_user_id());

create policy runs_owner_select on echiche.thought_runs for select to echiche_end_user
  using (owner_user_id = echiche.current_user_id());
create policy runs_owner_insert on echiche.thought_runs for insert to echiche_end_user
  with check (owner_user_id = echiche.current_user_id());
create policy runs_owner_update on echiche.thought_runs for update to echiche_end_user
  using (owner_user_id = echiche.current_user_id())
  with check (owner_user_id = echiche.current_user_id());

create policy events_owner_select on echiche.run_events for select to echiche_end_user
  using (owner_user_id = echiche.current_user_id());
create policy events_owner_insert on echiche.run_events for insert to echiche_end_user
  with check (owner_user_id = echiche.current_user_id());

create policy projects_worker_select on echiche.projects for select to echiche_worker using (true);
create policy runs_worker_select on echiche.thought_runs for select to echiche_worker using (true);
create policy runs_worker_update on echiche.thought_runs for update to echiche_worker using (true) with check (true);
create policy events_worker_select on echiche.run_events for select to echiche_worker using (true);
create policy events_worker_insert on echiche.run_events for insert to echiche_worker with check (true);

-- ---------------------------------------------------------------------------
-- 6. Housekeeping: the M1 in-repo migration runner's history table (superseded by the
--    Supabase CLI, ADR-002). Exists only on databases migrated with scripts/migrate.mjs.
-- ---------------------------------------------------------------------------
drop table if exists public.echiche_schema_migrations;
