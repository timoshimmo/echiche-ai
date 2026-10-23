import postgres from "postgres";

/** Fails fast with a clear message instead of letting every test time out. */
export default async function setup() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error("Integration tests require DATABASE_URL pointing at a disposable, migrated Postgres database (see README).");
  }
  const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 5, onnotice: () => {} });
  try {
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from echiche_schema_migrations where filename = '0002_run_failure_and_event_sequence.sql'`;
    if (!row || row.n !== 1) throw new Error("Database is not migrated. Run `npm run db:migrate` first.");
  } catch (error) {
    if (error instanceof Error && /echiche_schema_migrations/.test(error.message)) {
      throw new Error("Database is not migrated. Run `npm run db:migrate` first.");
    }
    throw error;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
