import { randomUUID } from "node:crypto";
import postgres from "postgres";

/** Superuser connection for test setup/cleanup only. Never used by application code. */
export function adminSql() {
  return postgres(process.env.TEST_ADMIN_DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
}

/** The app's runtime role, exactly as production connects. */
export function webSql() {
  return postgres(process.env.DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
}

/** A synthetic auth user (auth.users exists in Supabase, or via the plain-Postgres shim). */
export async function createTestUser(admin: postgres.Sql): Promise<string> {
  const id = randomUUID();
  await admin`insert into auth.users (id, email) values (${id}, ${`test-${id}@example.test`})`;
  return id;
}

export async function resetData(admin: postgres.Sql): Promise<void> {
  await admin`truncate echiche.projects, echiche.thought_runs, echiche.run_events cascade`;
  await admin`delete from auth.users where email like 'test-%@example.test'`;
}
