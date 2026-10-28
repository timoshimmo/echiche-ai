import { afterAll, describe, expect, it } from "vitest";
import { adminSql } from "@/test/db";

/**
 * M8 security review: deletion consistency. Every table that holds a user's data must be removed
 * when the account is deleted (auth.users), through ON DELETE CASCADE chains: a new table that
 * forgets this fails here, before it can leave orphaned personal data behind.
 */
const admin = adminSql();
afterAll(async () => { await admin.end({ timeout: 5 }); });

/** Tables with no per-user data, and why. */
const NOT_USER_DATA: Record<string, string> = {
  worker_heartbeats: "worker liveness rows: worker ID and timestamps only"
};

describe("account deletion reaches every table with user data", () => {
  it("each echiche table cascades from auth.users (directly or through its parents)", async () => {
    const tables = (await admin<{ name: string }[]>`
      select c.relname as name from pg_class c where c.relnamespace = 'echiche'::regnamespace and c.relkind = 'r'`).map(t => t.name);
    const edges = await admin<{ child: string; parent: string; parent_schema: string; cascade: boolean }[]>`
      select c.relname as child, p.relname as parent, pn.nspname as parent_schema, k.confdeltype = 'c' as cascade
        from pg_constraint k
        join pg_class c on c.oid = k.conrelid
        join pg_class p on p.oid = k.confrelid
        join pg_namespace pn on pn.oid = p.relnamespace
       where k.contype = 'f' and c.relnamespace = 'echiche'::regnamespace`;
    const reaches = new Map<string, boolean>();
    const visit = (table: string, seen = new Set<string>()): boolean => {
      if (reaches.has(table)) return reaches.get(table)!;
      if (seen.has(table)) return false;
      seen.add(table);
      const ok = edges.some(e => e.child === table && e.cascade &&
        ((e.parent_schema === "auth" && e.parent === "users") || (e.parent_schema === "echiche" && e.parent !== table && visit(e.parent, seen))));
      reaches.set(table, ok);
      return ok;
    };
    const orphans = tables.filter(t => !(t in NOT_USER_DATA) && !visit(t));
    expect(orphans).toEqual([]);
    expect(tables).toContain("usage_ledger");
  });

  it("every table with an owner column keys it to the owner (RLS and the cascade rely on it)", async () => {
    const missing = await admin<{ table_name: string }[]>`
      select c.relname as table_name from pg_class c
       where c.relnamespace = 'echiche'::regnamespace and c.relkind = 'r'
         and not exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'owner_user_id' and not a.attisdropped)`;
    expect(missing.map(m => m.table_name).filter(t => !(t in NOT_USER_DATA))).toEqual([]);
  });
});
