-- M1 foundation: record why a run failed, version the stored result, and give
-- run events a deterministic per-run order (created_at alone can tie).
-- Still no auth/RLS. See 0001 header; that arrives in M2.

alter table thought_runs
  add column if not exists error_code text
    check (error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  add column if not exists result_schema_version text;

-- 0.1.0 bound JSON.stringify(result) into the jsonb column, which stored a JSONB
-- *string* scalar (jsonb_typeof = 'string') instead of an object. Verified against
-- Postgres 16 on 2026-10-23. Unwrap those rows into real objects.
update thought_runs
   set result = (result #>> '{}')::jsonb
 where jsonb_typeof(result) = 'string';

-- Existing rows written by 0.1.0 used the scaffold result shape.
update thought_runs
   set result_schema_version = 'reasoning-scaffold.v1'
 where result is not null and result_schema_version is null;

alter table run_events add column if not exists sequence integer;

-- Backfill any existing events in their current (created_at, id) order.
with ordered as (
  select id, row_number() over (partition by run_id order by created_at, id) as seq
    from run_events
)
update run_events e
   set sequence = ordered.seq
  from ordered
 where e.id = ordered.id and e.sequence is null;

alter table run_events alter column sequence set not null;
alter table run_events add constraint run_events_sequence_positive check (sequence > 0);
alter table run_events add constraint run_events_run_sequence_key unique (run_id, sequence);

-- The unique constraint's index replaces the created_at ordering index.
drop index if exists run_events_run_created_idx;
