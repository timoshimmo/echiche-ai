#!/usr/bin/env node
// Prepares a DISPOSABLE database for integration tests. Never point it at shared data.
//
//   TEST_ADMIN_DATABASE_URL=postgresql://postgres@localhost:5432/echiche_test npm run test:db:prepare
//
// 1. If the database has no Supabase `auth` schema (plain PostgreSQL), applies the
//    test-only shim in src/test/sql/plain-postgres-shim.sql. Real Supabase stacks
//    (`supabase start`) already have it and are left untouched.
// 2. Applies supabase/migrations with the Supabase CLI (`supabase migration up`).
// 3. Gives the echiche_web and echiche_worker roles LOGIN with the TEST-ONLY password
//    in TEST_ROLE_PASSWORD (default "test-only-password"). Roles are cluster-wide, so
//    use a throwaway cluster/container.
// Prints the DATABASE_URL to use for `npm run test:integration`.
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import postgres from "postgres";

const adminUrl = process.env.TEST_ADMIN_DATABASE_URL?.trim();
if (!adminUrl || !/^postgres(ql)?:\/\//.test(adminUrl)) {
  console.error("test:db:prepare: set TEST_ADMIN_DATABASE_URL to a superuser URL for a disposable database.");
  process.exit(2);
}
const rolePassword = process.env.TEST_ROLE_PASSWORD || "test-only-password";
if (!/^[A-Za-z0-9_-]{8,64}$/.test(rolePassword)) {
  console.error("test:db:prepare: TEST_ROLE_PASSWORD must be 8-64 characters of [A-Za-z0-9_-].");
  process.exit(2);
}

const sql = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
try {
  const [{ has_auth }] = await sql`select exists (select 1 from information_schema.tables where table_schema = 'auth' and table_name = 'users') as has_auth`;
  if (!has_auth) {
    await sql.unsafe(await readFile(new URL("../src/test/sql/plain-postgres-shim.sql", import.meta.url), "utf8"));
    console.log("applied  plain-postgres shim (no Supabase auth schema found)");
  } else {
    console.log("found    Supabase auth schema; shim not needed");
  }

  // The CLI negotiates TLS by default; local test servers usually don't offer it.
  const cliUrl = new URL(adminUrl);
  if (["localhost", "127.0.0.1"].includes(cliUrl.hostname) && !cliUrl.searchParams.has("sslmode")) cliUrl.searchParams.set("sslmode", "disable");
  execFileSync("npx", ["--no-install", "supabase", "migration", "up", "--db-url", cliUrl.toString()], { stdio: "inherit" });

  for (const role of ["echiche_web", "echiche_worker"]) {
    await sql.unsafe(`alter role ${role} with login password '${rolePassword}'`);
  }

  // On a real Supabase stack the admin role (postgres) is not a superuser, so the RLS
  // tests' admin connection needs explicit SET permission to impersonate our roles.
  // TEST-ONLY: migrations never grant this.
  const [{ rolsuper }] = await sql`select rolsuper from pg_roles where rolname = current_user`;
  if (!rolsuper) {
    for (const role of ["echiche_end_user", "echiche_worker"]) {
      await sql.unsafe(`grant ${role} to current_user with inherit false, set true`);
    }
    console.log("granted  SET on echiche_end_user/echiche_worker to the admin role (non-superuser stack)");
  }
  const appUrl = new URL(adminUrl);
  appUrl.username = "echiche_web";
  appUrl.password = rolePassword;
  appUrl.searchParams.delete("sslmode");
  console.log(`ready    DATABASE_URL=${appUrl.toString()}`);
} catch (error) {
  console.error(`test:db:prepare failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
