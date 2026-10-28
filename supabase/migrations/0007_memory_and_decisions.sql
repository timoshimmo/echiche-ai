-- M6: user-controlled memory and decision journal (ADR-009).
--   * echiche.memories: versioned. The worker writes *proposals* after a run; nothing becomes
--     durable until the owner approves it. A correction is a new version that supersedes
--     the old one, so history is kept. Deletion is a hard delete of the whole lineage.
--   * echiche.decisions: versioned per project. Accepting a brief or revising a decision
--     appends a version; earlier rationale stays readable.
--   * echiche.decision_outcomes: append-only observations after a decision.
--   * echiche.run_memory_context: which remembered items (snapshot) a run was given.
--   * End users may now delete their projects (hard delete, cascades to everything).

-- ---------------------------------------------------------------------------
-- 1. Memories
-- ---------------------------------------------------------------------------
create table echiche.memories (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  project_id uuid not null,
  lineage_id uuid not null,
  version integer not null default 1 check (version >= 1),
  supersedes_id uuid references echiche.memories (id) on delete cascade,
  kind text not null check (kind in ('goal', 'constraint', 'assumption', 'decision', 'open_question', 'fact')),
  content text not null check (char_length(trim(content)) between 1 and 500),
  status text not null check (status in ('proposed', 'active', 'superseded', 'rejected')),
  origin text not null check (origin in ('model_proposal', 'user')),
  edited boolean not null default false,
  sensitivity text not null default 'normal' check (sensitivity in ('normal', 'sensitive')),
  confidence text check (confidence is null or confidence in ('low', 'medium', 'high')),
  source_run_id uuid,
  proposal_index integer check (proposal_index is null or proposal_index between 0 and 49),
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default clock_timestamp(),
  reviewed_at timestamptz,
  valid_from timestamptz,
  valid_to timestamptz,
  unique (id, owner_user_id),
  unique (lineage_id, version),
  unique (source_run_id, proposal_index),
  foreign key (project_id, owner_user_id) references echiche.projects (id, owner_user_id) on delete cascade,
  foreign key (source_run_id, owner_user_id) references echiche.thought_runs (id, owner_user_id)
    on delete set null (source_run_id)
);
create unique index memories_one_active_per_lineage on echiche.memories (lineage_id) where status = 'active';
create index memories_project_idx on echiche.memories (project_id, status, kind, created_at desc);

create function echiche.enforce_memory_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.lineage_id := coalesce(new.lineage_id, new.id);
    if current_user = 'echiche_worker' then
      if new.status <> 'proposed' or new.origin <> 'model_proposal' or new.version <> 1 or new.supersedes_id is not null then
        raise exception 'the worker may only insert memory proposals' using errcode = 'P0001', hint = 'MEMORY_STATE_CONFLICT';
      end if;
    elsif current_user = 'echiche_end_user' then
      if new.status <> 'active' or new.origin <> 'user' or new.proposal_index is not null then
        raise exception 'users insert active memories only' using errcode = 'P0001', hint = 'MEMORY_STATE_CONFLICT';
      end if;
      new.valid_from := now();
      new.reviewed_at := now();
    end if;
    return new;
  end if;

  -- UPDATE
  if current_user in ('echiche_end_user', 'echiche_worker') then
    if (new.id, new.owner_user_id, new.project_id, new.lineage_id, new.version, new.supersedes_id, new.origin,
        new.source_run_id, new.proposal_index, new.observed_at, new.created_at, new.sensitivity)
       is distinct from
       (old.id, old.owner_user_id, old.project_id, old.lineage_id, old.version, old.supersedes_id, old.origin,
        old.source_run_id, old.proposal_index, old.observed_at, old.created_at, old.sensitivity) then
      raise exception 'memory identity and provenance are immutable' using errcode = 'P0001', hint = 'MEMORY_STATE_CONFLICT';
    end if;
    if old.status = 'proposed' and new.status in ('active', 'rejected') then
      new.reviewed_at := now();
      new.valid_from := case when new.status = 'active' then now() else null end;
      new.edited := old.edited or new.content is distinct from old.content or new.kind is distinct from old.kind;
    elsif old.status = 'proposed' and new.status = 'proposed' then
      null;  -- editing a proposal before review
    elsif old.status = 'active' and new.status = 'superseded'
          and new.content = old.content and new.kind = old.kind and new.confidence is not distinct from old.confidence then
      new.valid_to := now();
    else
      raise exception 'memory % cannot change from % to % this way', old.id, old.status, new.status
        using errcode = 'P0001', hint = 'MEMORY_STATE_CONFLICT';
    end if;
  end if;
  return new;
end $$;

create trigger memories_enforce_change
  before insert or update on echiche.memories
  for each row execute function echiche.enforce_memory_change();

-- ---------------------------------------------------------------------------
-- 2. Decisions and outcomes
-- ---------------------------------------------------------------------------
create table echiche.decisions (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  project_id uuid not null,
  version integer not null check (version >= 1),
  supersedes_id uuid references echiche.decisions (id) on delete cascade,
  status text not null check (status in ('active', 'superseded')),
  origin text not null check (origin in ('accepted_brief', 'user_revision')),
  source_run_id uuid,
  question text not null check (char_length(question) between 1 and 1000),
  choice text not null check (char_length(choice) between 1 and 1000),
  rationale text not null check (char_length(rationale) between 1 and 4000),
  alternatives jsonb not null default '[]' check (jsonb_typeof(alternatives) = 'array'),
  assumptions jsonb not null default '[]' check (jsonb_typeof(assumptions) = 'array'),
  confidence text check (confidence is null or confidence in ('low', 'medium', 'high')),
  review_triggers jsonb not null default '[]' check (jsonb_typeof(review_triggers) = 'array'),
  next_actions jsonb not null default '[]' check (jsonb_typeof(next_actions) = 'array'),
  created_at timestamptz not null default clock_timestamp(),
  superseded_at timestamptz,
  unique (id, owner_user_id),
  unique (project_id, version),
  foreign key (project_id, owner_user_id) references echiche.projects (id, owner_user_id) on delete cascade,
  foreign key (source_run_id, owner_user_id) references echiche.thought_runs (id, owner_user_id)
    on delete set null (source_run_id)
);
create unique index decisions_one_active_per_project on echiche.decisions (project_id) where status = 'active';
create unique index decisions_one_per_run on echiche.decisions (source_run_id) where source_run_id is not null;

create function echiche.enforce_decision_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('echiche_end_user', 'echiche_worker') then
    if old.status = 'active' and new.status = 'superseded'
       and (to_jsonb(new) - 'status' - 'superseded_at') = (to_jsonb(old) - 'status' - 'superseded_at') then
      new.superseded_at := now();
      return new;
    end if;
    raise exception 'decision versions are immutable; record a new version instead'
      using errcode = 'P0001', hint = 'DECISION_STATE_CONFLICT';
  end if;
  return new;
end $$;

create trigger decisions_enforce_change
  before update on echiche.decisions
  for each row execute function echiche.enforce_decision_change();

create table echiche.decision_outcomes (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  decision_id uuid not null,
  result text not null check (result in ('as_expected', 'better', 'worse', 'mixed', 'too_early')),
  observed_outcome text not null check (char_length(trim(observed_outcome)) between 1 and 2000),
  observed_on date not null,
  notes text check (notes is null or char_length(notes) <= 2000),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (decision_id, owner_user_id) references echiche.decisions (id, owner_user_id) on delete cascade
);
create index decision_outcomes_decision_idx on echiche.decision_outcomes (decision_id, created_at);

-- ---------------------------------------------------------------------------
-- 3. What each run was given from memory (snapshot, for provenance of the brief)
-- ---------------------------------------------------------------------------
create table echiche.run_memory_context (
  run_id uuid not null,
  owner_user_id uuid not null,
  ref text not null check (ref ~ '^(M|D)[0-9]{1,3}$'),
  memory_id uuid,
  decision_id uuid,
  kind text not null check (char_length(kind) <= 32),
  content text not null check (char_length(content) between 1 and 2000),
  observed_at timestamptz not null,
  primary key (run_id, ref),
  check ((memory_id is null) <> (decision_id is null)),
  foreign key (run_id, owner_user_id) references echiche.thought_runs (id, owner_user_id) on delete cascade,
  foreign key (memory_id, owner_user_id) references echiche.memories (id, owner_user_id) on delete cascade,
  foreign key (decision_id, owner_user_id) references echiche.decisions (id, owner_user_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- 4. Privileges and row-level security
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['memories', 'decisions', 'decision_outcomes', 'run_memory_context'] loop
    execute format('alter table echiche.%I enable row level security', t);
    execute format('alter table echiche.%I force row level security', t);
    execute format('create policy %I on echiche.%I for select to echiche_end_user using (owner_user_id = echiche.current_user_id())',
                   t || '_owner_select', t);
    execute format('create policy %I on echiche.%I for select to echiche_worker using (true)', t || '_worker_select', t);
  end loop;
  foreach t in array array['memories', 'decisions', 'decision_outcomes'] loop
    execute format('create policy %I on echiche.%I for insert to echiche_end_user with check (owner_user_id = echiche.current_user_id())',
                   t || '_owner_insert', t);
    execute format('create policy %I on echiche.%I for delete to echiche_end_user using (owner_user_id = echiche.current_user_id())',
                   t || '_owner_delete', t);
  end loop;
  foreach t in array array['memories', 'decisions'] loop
    execute format('create policy %I on echiche.%I for update to echiche_end_user using (owner_user_id = echiche.current_user_id()) with check (owner_user_id = echiche.current_user_id())',
                   t || '_owner_update', t);
  end loop;
end $$;
create policy memories_worker_insert on echiche.memories for insert to echiche_worker with check (true);
create policy run_memory_context_worker_insert on echiche.run_memory_context for insert to echiche_worker with check (true);

grant select, delete on echiche.memories, echiche.decisions, echiche.decision_outcomes to echiche_end_user;
grant select on echiche.run_memory_context to echiche_end_user;
grant insert (id, owner_user_id, project_id, lineage_id, version, supersedes_id, kind, content, status, origin,
              sensitivity, confidence, observed_at) on echiche.memories to echiche_end_user;
grant update (content, kind, confidence, status, edited, reviewed_at, valid_from, valid_to) on echiche.memories to echiche_end_user;
grant insert (owner_user_id, project_id, version, supersedes_id, status, origin, source_run_id, question, choice, rationale,
              alternatives, assumptions, confidence, review_triggers, next_actions) on echiche.decisions to echiche_end_user;
grant update (status, superseded_at) on echiche.decisions to echiche_end_user;
grant insert (owner_user_id, decision_id, result, observed_outcome, observed_on, notes) on echiche.decision_outcomes to echiche_end_user;

grant select on echiche.memories, echiche.decisions, echiche.decision_outcomes, echiche.run_memory_context to echiche_worker;
grant insert (owner_user_id, project_id, kind, content, status, origin, sensitivity, confidence, source_run_id,
              proposal_index, observed_at) on echiche.memories to echiche_worker;
grant insert on echiche.run_memory_context to echiche_worker;

-- Projects: owners may now delete them (hard delete; foreign keys cascade to runs, events,
-- checkpoints, telemetry, sources, claims, memories, decisions and outcomes).
grant delete on echiche.projects to echiche_end_user;
create policy projects_owner_delete on echiche.projects for delete to echiche_end_user
  using (owner_user_id = echiche.current_user_id());

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on echiche.memories, echiche.decisions, echiche.decision_outcomes, echiche.run_memory_context from %I', r);
    end if;
  end loop;
end $$;
revoke all on echiche.memories, echiche.decisions, echiche.decision_outcomes, echiche.run_memory_context from public;
