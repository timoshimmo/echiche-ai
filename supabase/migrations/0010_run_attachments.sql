-- Run attachments: files and reference links a user adds to a question (ADR-012).
--
-- The web app extracts text from documents, spreadsheets, PDFs and Word files when the run is
-- queued (status 'ready', or 'failed' with a note). Images and links are read later by the worker,
-- which has the model credentials and the SSRF-safe fetcher (status 'pending' until then).
-- Only extracted text is kept, plus image bytes until the worker has read them. The original file
-- is never stored. Attachments belong to their run: deleting the run's project (or the account)
-- removes them. The UI shows names and status only; the text is model input, never displayed.
create table echiche.run_attachments (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  run_id uuid not null,
  position smallint not null check (position between 1 and 5),
  kind text not null check (kind in ('text', 'pdf', 'word', 'spreadsheet', 'image', 'link')),
  name text not null check (char_length(name) between 1 and 300),
  media_type text check (media_type is null or char_length(media_type) <= 100),
  size_bytes integer not null default 0 check (size_bytes between 0 and 10485760),
  url text check (url is null or (url ~ '^https://' and char_length(url) <= 2048)),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('ready', 'pending', 'failed')),
  extracted_text text check (extracted_text is null or char_length(extracted_text) <= 15000),
  truncated boolean not null default false,
  image_data bytea check (image_data is null or octet_length(image_data) <= 4194304),
  note text check (note is null or char_length(note) <= 300),
  created_at timestamptz not null default clock_timestamp(),
  read_at timestamptz,
  unique (run_id, position),
  unique (id, owner_user_id),
  check ((kind = 'link') = (url is not null)),
  check (image_data is null or kind = 'image'),
  check (status <> 'ready' or extracted_text is not null),
  foreign key (run_id, owner_user_id) references echiche.thought_runs (id, owner_user_id) on delete cascade
);
create index run_attachments_run_idx on echiche.run_attachments (run_id, position);

alter table echiche.run_attachments enable row level security;
alter table echiche.run_attachments force row level security;

-- End users add attachments to their own runs (in the transaction that queues the run) and read
-- their own. They cannot change them afterwards; deletion happens only through the cascade.
grant select, insert on echiche.run_attachments to echiche_end_user;
create policy run_attachments_owner_select on echiche.run_attachments for select to echiche_end_user
  using (owner_user_id = echiche.current_user_id());
create policy run_attachments_owner_insert on echiche.run_attachments for insert to echiche_end_user
  with check (
    owner_user_id = echiche.current_user_id()
    and exists (select 1 from echiche.thought_runs r
                 where r.id = run_id and r.owner_user_id = echiche.current_user_id() and r.status = 'queued')
  );

-- The worker reads attachments and records what it read from images and links. It can only fill
-- in the reading result; it cannot rename, re-point or add attachments.
grant select on echiche.run_attachments to echiche_worker;
grant update (status, extracted_text, truncated, image_data, note, read_at) on echiche.run_attachments to echiche_worker;
create policy run_attachments_worker_select on echiche.run_attachments for select to echiche_worker using (true);
create policy run_attachments_worker_update on echiche.run_attachments for update to echiche_worker
  using (status = 'pending') with check (true);
