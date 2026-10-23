#!/usr/bin/env node
// Applies supabase/migrations/*.sql in filename order, each in its own transaction,
// recording applied files (with a SHA-256 checksum) in public.echiche_schema_migrations.
// Already-applied files are skipped; an edited applied file is a hard error.
//
//   DATABASE_URL=postgresql://... npm run db:migrate
//   DATABASE_URL=postgresql://... npm run db:migrate -- --status
//   DATABASE_URL=postgresql://... npm run db:migrate -- --baseline=0001_initial_schema.sql
//     (existing 0.1.0 databases where 0001 was applied by hand: record files up to and
//      including the named one as applied WITHOUT running them, then migrate normally)
//
// Use this OR the Supabase CLI for a given database, never both (they track history separately).
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";

const MIGRATIONS_DIR = new URL("../supabase/migrations/", import.meta.url).pathname;
const statusOnly = process.argv.includes("--status");
const baselineArg = process.argv.find(a => a.startsWith("--baseline="));
const baseline = baselineArg ? baselineArg.slice("--baseline=".length) : null;

const url = process.env.DATABASE_URL?.trim();
if (!url || !/^postgres(ql)?:\/\//.test(url)) {
  console.error("db:migrate: DATABASE_URL must be set to a postgres:// or postgresql:// URL.");
  process.exit(2);
}

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });

try {
  await sql`
    create table if not exists echiche_schema_migrations (
      filename text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )`;

  const files = (await readdir(MIGRATIONS_DIR)).filter(f => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const applied = new Map((await sql`select filename, checksum from echiche_schema_migrations`).map(r => [r.filename, r.checksum]));

  if (baseline && !files.includes(baseline)) throw new Error(`--baseline file not found: ${baseline}`);

  let count = 0;
  for (const file of files) {
    const body = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    const checksum = createHash("sha256").update(body).digest("hex");
    const previous = applied.get(file);
    if (previous) {
      if (previous !== checksum) throw new Error(`${file} was modified after being applied. Add a new migration instead.`);
      if (statusOnly) console.log(`applied  ${file}`);
      continue;
    }
    if (statusOnly) {
      console.log(`pending  ${file}`);
      continue;
    }
    if (baseline && file <= baseline) {
      await sql`insert into echiche_schema_migrations (filename, checksum) values (${file}, ${checksum})`;
      console.log(`baseline ${file} (recorded, not executed)`);
      continue;
    }
    await sql.begin(async tx => {
      await tx.unsafe(body);
      await tx`insert into echiche_schema_migrations (filename, checksum) values (${file}, ${checksum})`;
    });
    console.log(`applied  ${file}`);
    count += 1;
  }
  if (!statusOnly) console.log(count ? `db:migrate: ${count} migration(s) applied.` : "db:migrate: up to date.");
} catch (error) {
  // Print the driver message: this is an operator tool, not a request path.
  console.error(`db:migrate failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
