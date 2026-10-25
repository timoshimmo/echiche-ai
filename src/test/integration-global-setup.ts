import postgres from "postgres";

/**
 * Integration tests need two connections to a DISPOSABLE database prepared with
 * `npm run test:db:prepare`:
 *   DATABASE_URL             - the app's runtime role (echiche_web), as in production
 *   TEST_ADMIN_DATABASE_URL  - a superuser, used only to create test users and clean up
 * Fails fast (never skips) when either is missing or the schema is not migrated.
 */
export default async function setup() {
  const appUrl = process.env.DATABASE_URL?.trim();
  const adminUrl = process.env.TEST_ADMIN_DATABASE_URL?.trim();
  if (!appUrl || !adminUrl) {
    throw new Error("Integration tests require DATABASE_URL (echiche_web) and TEST_ADMIN_DATABASE_URL (superuser) for a disposable database. Run `npm run test:db:prepare` (see README).");
  }
  if (new URL(appUrl).username !== "echiche_web") {
    throw new Error("DATABASE_URL must connect as echiche_web so tests exercise the production connection context.");
  }
  const sql = postgres(adminUrl, { max: 1, prepare: false, connect_timeout: 5, onnotice: () => {} });
  try {
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from supabase_migrations.schema_migrations where version = '0003'`;
    if (!row || row.n !== 1) throw new Error("not migrated");
  } catch {
    throw new Error("Database is not migrated through 0003. Run `npm run test:db:prepare` first.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}
