-- TEST-ONLY shim: the minimum of Supabase's environment that our migrations depend on,
-- so they can be applied and the security tests run against plain PostgreSQL (no Docker).
-- NEVER apply this to a Supabase project; those already have the real objects.
--
-- Mirrors: the auth.users table (only the columns we reference) and the anon /
-- authenticated / service_role API roles that receive Supabase's default grants.
-- The CI job "supabase-stack" runs the same tests against the real Supabase stack.

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
    end if;
  end loop;
end $$;

-- Supabase makes its (non-superuser) postgres role a member of the API roles; mirror
-- that when the shim is applied by a non-superuser, as in a Supabase-like role setup.
do $$
begin
  if not (select rolsuper from pg_roles where rolname = current_user) then
    execute format('grant anon, authenticated, service_role to %I', current_user);
  end if;
end $$;

create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  created_at timestamptz not null default now()
);

-- Reproduce Supabase's default privileges on public so migration 0003's revokes are exercised.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
