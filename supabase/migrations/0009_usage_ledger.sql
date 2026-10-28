-- M8 (security review, finding F1): an append-only usage ledger for abuse limits.
--
-- Hourly limits used to count rows in projects / thought_runs. Since M6 an owner can hard-delete a
-- project, which cascades to its runs (and their model_calls), so deleting and recreating reset the
-- limits and erased the spend record. The ledger is independent of projects: it records only the kind
-- of action, a reserved spend cap and a timestamp, with no project ID and no content, so deleting a
-- project leaves nothing identifiable behind. Account deletion removes it (cascade from auth.users).
--
-- It backs: hourly creation limits (projects, runs, exports, journal writes) and daily spend
-- reservations (each run's spend cap, and each resume's increment, count in full when queued; actual
-- spend can only be lower), per user and across all users.
create table echiche.usage_ledger (
  id bigint generated always as identity primary key,
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('project', 'run', 'resume', 'export', 'journal_write')),
  reserved_cost_usd numeric(10, 4) not null default 0 check (reserved_cost_usd >= 0),
  created_at timestamptz not null default now()
);
create index usage_ledger_owner_kind_time on echiche.usage_ledger (owner_user_id, kind, created_at);
create index usage_ledger_time on echiche.usage_ledger (created_at) where reserved_cost_usd > 0;

alter table echiche.usage_ledger enable row level security;
alter table echiche.usage_ledger force row level security;
-- End users append their own rows and read only their own. Nobody updates or deletes through the app.
grant select on echiche.usage_ledger to echiche_end_user;
grant insert (owner_user_id, kind, reserved_cost_usd) on echiche.usage_ledger to echiche_end_user;
create policy usage_ledger_owner_select on echiche.usage_ledger for select to echiche_end_user
  using (owner_user_id = echiche.current_user_id());
create policy usage_ledger_owner_insert on echiche.usage_ledger for insert to echiche_end_user
  with check (owner_user_id = echiche.current_user_id());

-- Spend reserved by everyone in a window: the global daily ceiling. SECURITY DEFINER so an end user
-- can learn the total (one number) without reading other owners' rows.
create or replace function echiche.global_reserved_spend(p_window interval)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(reserved_cost_usd), 0)
    from echiche.usage_ledger
   where created_at > now() - p_window and reserved_cost_usd > 0
$$;
revoke all on function echiche.global_reserved_spend(interval) from public;
grant execute on function echiche.global_reserved_spend(interval) to echiche_end_user;
