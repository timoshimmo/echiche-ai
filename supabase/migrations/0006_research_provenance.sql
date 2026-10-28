-- M5: research provenance (ADR-008).
--   * echiche.sources: pages the worker actually read (canonical URL, title, publisher,
--     dates, content hash, short excerpts). Search results themselves are never stored.
--   * echiche.claims + echiche.claim_sources: claims extracted from those pages, each tied
--     to an exact quote from a stored passage, with the deterministic and model verdicts.
--   * echiche.research_calls: telemetry for searches and page fetches (no query text,
--     no page content; the fetched domain only).
-- All rows belong to a run and are deleted with it (and with the account).

-- ---------------------------------------------------------------------------
-- 1. Sources
-- ---------------------------------------------------------------------------
create table echiche.sources (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  run_id uuid not null,
  source_key text not null check (source_key ~ '^S[0-9]{1,3}$'),
  url text not null check (url ~ '^https://' and char_length(url) <= 2048),
  domain text not null check (char_length(domain) between 1 and 253),
  title text not null check (char_length(title) between 1 and 300),
  publisher text check (publisher is null or char_length(publisher) <= 200),
  published_at text check (published_at is null or char_length(published_at) <= 40),
  retrieved_at timestamptz not null,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  search_query text not null check (char_length(search_query) <= 400),
  passages jsonb not null check (jsonb_typeof(passages) = 'array' and jsonb_array_length(passages) between 1 and 3),
  created_at timestamptz not null default clock_timestamp(),
  unique (run_id, source_key),
  unique (id, owner_user_id),
  foreign key (run_id, owner_user_id) references echiche.thought_runs (id, owner_user_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- 2. Claims and their evidence links
-- ---------------------------------------------------------------------------
create table echiche.claims (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  run_id uuid not null,
  claim_key text not null check (claim_key ~ '^C[0-9]{1,3}$'),
  text text not null check (char_length(text) between 1 and 500),
  label text not null check (label in ('fact', 'inference', 'hypothesis', 'speculation', 'unknown')),
  status text not null check (status in ('verified', 'partial', 'unsupported', 'invalid')),
  freshness text not null check (freshness in ('fresh', 'stale', 'unknown')),
  contradicted boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  unique (run_id, claim_key),
  unique (id, owner_user_id),
  foreign key (run_id, owner_user_id) references echiche.thought_runs (id, owner_user_id) on delete cascade
);

create table echiche.claim_sources (
  claim_id uuid not null,
  source_id uuid not null,
  owner_user_id uuid not null,
  passage_key text not null check (passage_key ~ '^S[0-9]{1,3}\.p[0-9]{1,2}$'),
  relation text not null check (relation in ('supports', 'contradicts', 'context')),
  quote text not null check (char_length(quote) between 1 and 500),
  verdict text not null check (verdict in ('supported', 'partially_supported', 'not_supported', 'quote_not_found')),
  note text not null check (char_length(note) <= 500),
  primary key (claim_id, passage_key),
  foreign key (claim_id, owner_user_id) references echiche.claims (id, owner_user_id) on delete cascade,
  foreign key (source_id, owner_user_id) references echiche.sources (id, owner_user_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- 3. Research telemetry
-- ---------------------------------------------------------------------------
create table echiche.research_calls (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  run_id uuid not null,
  attempt integer not null check (attempt >= 1),
  kind text not null check (kind in ('search', 'fetch', 'robots')),
  provider text not null check (provider ~ '^[a-z0-9_-]{1,32}$'),
  outcome text not null check (outcome ~ '^[a-z_]{1,32}$'),
  http_status integer check (http_status is null or http_status between 100 and 599),
  domain text check (domain is null or char_length(domain) <= 253),
  result_count integer not null default 0 check (result_count >= 0),
  bytes integer not null default 0 check (bytes >= 0),
  cost_usd numeric(12, 6) not null default 0 check (cost_usd >= 0),
  latency_ms integer not null check (latency_ms >= 0),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (run_id, owner_user_id) references echiche.thought_runs (id, owner_user_id) on delete cascade
);

create index sources_run_idx on echiche.sources (run_id);
create index claims_run_idx on echiche.claims (run_id);
create index claim_sources_source_idx on echiche.claim_sources (source_id);
create index research_calls_run_idx on echiche.research_calls (run_id, created_at);

-- ---------------------------------------------------------------------------
-- 4. Row-level security: owners read their own rows; the worker inserts and reads.
--    Nobody updates or deletes (except through the run/account cascade).
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['sources', 'claims', 'claim_sources', 'research_calls'] loop
    execute format('alter table echiche.%I enable row level security', t);
    execute format('alter table echiche.%I force row level security', t);
    execute format('grant select on echiche.%I to echiche_end_user, echiche_worker', t);
    execute format('grant insert on echiche.%I to echiche_worker', t);
    execute format('create policy %I on echiche.%I for select to echiche_end_user using (owner_user_id = echiche.current_user_id())',
                   t || '_owner_select', t);
    execute format('create policy %I on echiche.%I for select to echiche_worker using (true)', t || '_worker_select', t);
    execute format('create policy %I on echiche.%I for insert to echiche_worker with check (true)', t || '_worker_insert', t);
  end loop;
end $$;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on echiche.sources, echiche.claims, echiche.claim_sources, echiche.research_calls from %I', r);
    end if;
  end loop;
end $$;
revoke all on echiche.sources, echiche.claims, echiche.claim_sources, echiche.research_calls from public;
