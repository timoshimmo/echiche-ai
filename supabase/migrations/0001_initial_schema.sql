-- Echiche starter schema — PostgreSQL / Supabase compatible.
-- This migration intentionally does not enable RLS yet because this starter has no auth layer.
-- DO NOT expose this database to untrusted users until auth + ownership checks + RLS are implemented.
create extension if not exists pgcrypto;

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  title varchar(120) not null check (char_length(trim(title)) >= 2),
  problem_statement text not null check (char_length(trim(problem_statement)) between 10 and 5000),
  created_at timestamptz not null default now()
);

create index if not exists projects_created_at_idx on projects (created_at desc);

create table if not exists thought_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  prompt text not null check (char_length(trim(prompt)) between 10 and 8000),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed')),
  result jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists thought_runs_project_created_idx on thought_runs (project_id, created_at desc);
create index if not exists thought_runs_status_created_idx on thought_runs (status, created_at);

create table if not exists run_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references thought_runs(id) on delete cascade,
  event_type text not null check (event_type in ('status', 'stage', 'result', 'error')),
  stage varchar(80) not null,
  message text not null check (char_length(message) <= 10000),
  created_at timestamptz not null default now()
);

create index if not exists run_events_run_created_idx on run_events (run_id, created_at asc);
