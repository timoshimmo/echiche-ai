import type postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { adminSql, createTestUser, resetData, webSql } from "@/test/db";

/**
 * Database-layer isolation, tested WITHOUT the application's owner filters: every query
 * here is raw SQL that a buggy repository might issue. Only roles, grants and RLS stand
 * between users. Connection context is the production one: echiche_web, which switches
 * to echiche_end_user with the caller's claims for each transaction.
 */
const admin = adminSql();
const web = webSql();
let alice: string;
let bob: string;
let aliceProject: string;
let aliceRun: string;

const PERMISSION_DENIED = { code: "42501" };

/** Runs fn as the end user with the given claims, exactly like PostgresOwnerRepository.tx. */
function asUser<T>(userId: string | null, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return web.begin(async tx => {
    if (userId) await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`;
    await tx.unsafe("set local role echiche_end_user");
    return fn(tx);
  }) as Promise<T>;
}

/** Runs fn as an arbitrary role via the superuser connection (for roles echiche_web cannot assume). */
function asRole<T>(role: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return admin.begin(async tx => {
    await tx.unsafe(`set local role ${role}`);
    return fn(tx);
  }) as Promise<T>;
}

beforeEach(async () => {
  await resetData(admin);
  alice = await createTestUser(admin);
  bob = await createTestUser(admin);
  [{ id: aliceProject }] = await asUser(alice, tx => tx`
    insert into echiche.projects (owner_user_id, title, problem_statement)
    values (${alice}, 'Alice plan', 'Alice confidential decision') returning id`);
  [{ id: aliceRun }] = await asUser(alice, tx => tx`
    insert into echiche.thought_runs (owner_user_id, project_id, prompt)
    values (${alice}, ${aliceProject}, 'Alice private question') returning id`);
  // Events are written by the worker only (M3); seed one as an operator.
  await admin`
    insert into echiche.run_events (owner_user_id, run_id, sequence, event_type, stage, message)
    values (${alice}, ${aliceRun}, 1, 'status', 'started', 'started')`;
});

afterAll(async () => {
  await resetData(admin);
  await Promise.all([admin.end({ timeout: 5 }), web.end({ timeout: 5 })]);
});

describe("runtime connection context", () => {
  it("connects as echiche_web, which has no table privileges of its own (NOINHERIT)", async () => {
    const [{ current_user: user }] = await web`select current_user`;
    expect(user).toBe("echiche_web");
    await expect(web`select * from echiche.projects`).rejects.toMatchObject(PERMISSION_DENIED);
  });

  it("switches to echiche_end_user with the caller's identity inside the transaction only", async () => {
    const seen = await asUser(alice, tx => tx`select current_user, echiche.current_user_id() as uid`);
    expect(seen[0]).toEqual({ current_user: "echiche_end_user", uid: alice });
    const [after] = await web`select current_user, current_setting('request.jwt.claims', true) as claims`;
    expect(after.current_user).toBe("echiche_web");
    expect(after.claims ?? "").toBe("");
  });

  it("cannot escalate to other roles", async () => {
    for (const role of ["postgres", "echiche_worker", "anon", "authenticated", "service_role"]) {
      await expect(web.begin(tx => tx.unsafe(`set local role ${role}`))).rejects.toMatchObject(PERMISSION_DENIED);
    }
  });
});

describe("SELECT", () => {
  it("permitted: the owner sees their rows", async () => {
    const counts = await asUser(alice, tx => tx`
      select (select count(*) from echiche.projects)::int as p, (select count(*) from echiche.thought_runs)::int as r,
             (select count(*) from echiche.run_events)::int as e`);
    expect(counts[0]).toEqual({ p: 1, r: 1, e: 1 });
  });

  it("denied: another user sees zero rows even with no WHERE clause and a guessed ID", async () => {
    const rows = await asUser(bob, tx => tx`
      select (select count(*) from echiche.projects)::int as p, (select count(*) from echiche.thought_runs)::int as r,
             (select count(*) from echiche.run_events)::int as e,
             (select count(*) from echiche.projects where id = ${aliceProject})::int as guessed`);
    expect(rows[0]).toEqual({ p: 0, r: 0, e: 0, guessed: 0 });
  });

  it("denied: missing claims (no session) see zero rows", async () => {
    const rows = await asUser(null, tx => tx`select count(*)::int as n from echiche.projects`);
    expect(rows[0].n).toBe(0);
  });

  it("denied: forged claims for a non-UUID subject error out rather than match", async () => {
    await expect(web.begin(async tx => {
      await tx`select set_config('request.jwt.claims', '{"sub":"* or 1=1"}', true)`;
      await tx.unsafe("set local role echiche_end_user");
      return tx`select * from echiche.projects`;
    })).rejects.toMatchObject({ code: "22P02" });
  });
});

describe("INSERT", () => {
  it("permitted: the owner inserts rows they own", async () => {
    const rows = await asUser(alice, tx => tx`
      insert into echiche.projects (owner_user_id, title, problem_statement) values (${alice}, 'Second', 'Second decision text') returning id`);
    expect(rows).toHaveLength(1);
  });

  it("denied: inserting a row owned by someone else violates RLS", async () => {
    await expect(asUser(bob, tx => tx`
      insert into echiche.projects (owner_user_id, title, problem_statement) values (${alice}, 'Spoof', 'Spoofed owner text')`))
      .rejects.toMatchObject(PERMISSION_DENIED);
  });

  it("denied: attaching a child row to another user's parent (composite FK + RLS)", async () => {
    // Bob claims ownership of a run on Alice's project: the (project_id, owner) FK has no match.
    await expect(asUser(bob, tx => tx`
      insert into echiche.thought_runs (owner_user_id, project_id, prompt) values (${bob}, ${aliceProject}, 'Bob on Alice project')`))
      .rejects.toMatchObject({ code: "23503" });
    // ...and claiming Alice as owner is stopped by RLS.
    await expect(asUser(bob, tx => tx`
      insert into echiche.thought_runs (owner_user_id, project_id, prompt) values (${alice}, ${aliceProject}, 'Bob as Alice')`))
      .rejects.toMatchObject(PERMISSION_DENIED);
  });

  it("denied: runs can only be created as queued, and run events are worker-only", async () => {
    await expect(asUser(alice, tx => tx`
      insert into echiche.thought_runs (owner_user_id, project_id, prompt, status) values (${alice}, ${aliceProject}, 'Skip the queue', 'completed')`))
      .rejects.toMatchObject(PERMISSION_DENIED);
    await expect(asUser(alice, tx => tx`
      insert into echiche.run_events (owner_user_id, run_id, sequence, event_type, stage, message) values (${alice}, ${aliceRun}, 2, 'stage', 'x', 'x')`))
      .rejects.toMatchObject(PERMISSION_DENIED);
  });

  it("denied: columns outside the grant (e.g. id, created_at) cannot be supplied", async () => {
    await expect(asUser(alice, tx => tx`
      insert into echiche.projects (id, owner_user_id, title, problem_statement) values (gen_random_uuid(), ${alice}, 'Fixed id', 'Choosing my own id')`))
      .rejects.toMatchObject(PERMISSION_DENIED);
  });
});

describe("UPDATE", () => {
  it("permitted: the owner updates granted columns", async () => {
    const rows = await asUser(alice, tx => tx`update echiche.projects set title = 'Renamed' where id = ${aliceProject} returning title`);
    expect(rows[0].title).toBe("Renamed");
  });

  it("denied: another user's update matches zero rows", async () => {
    const rows = await asUser(bob, tx => tx`update echiche.projects set title = 'Hijacked' returning id`);
    expect(rows).toHaveLength(0);
    const runs = await asUser(bob, tx => tx`update echiche.thought_runs set status = 'cancelled' returning id`);
    expect(runs).toHaveLength(0);
    const [check] = await admin`select title from echiche.projects where id = ${aliceProject}`;
    expect(check.title).toBe("Alice plan");
  });

  it("denied: ownership cannot be reassigned (owner_user_id is not updatable)", async () => {
    await expect(asUser(alice, tx => tx`update echiche.projects set owner_user_id = ${bob} where id = ${aliceProject}`))
      .rejects.toMatchObject(PERMISSION_DENIED);
  });

  it("denied: end users cannot write results or execution fields", async () => {
    await expect(asUser(alice, tx => tx`update echiche.thought_runs set result = '{}'::jsonb`)).rejects.toMatchObject(PERMISSION_DENIED);
    await expect(asUser(alice, tx => tx`update echiche.thought_runs set steps_used = 0, claimed_by = 'me'`)).rejects.toMatchObject(PERMISSION_DENIED);
  });

  it("denied: run events are append-only for end users", async () => {
    await expect(asUser(alice, tx => tx`update echiche.run_events set message = 'rewritten'`))
      .rejects.toMatchObject(PERMISSION_DENIED);
  });
});

describe("DELETE", () => {
  it("owners may delete only their own projects (M6); runs and events are never deleted directly", async () => {
    for (const table of ["thought_runs", "run_events"]) {
      await expect(asUser(alice, tx => tx.unsafe(`delete from echiche.${table}`))).rejects.toMatchObject(PERMISSION_DENIED);
      await expect(asUser(bob, tx => tx.unsafe(`delete from echiche.${table}`))).rejects.toMatchObject(PERMISSION_DENIED);
    }
    await expect(asUser(alice, tx => tx`truncate echiche.projects cascade`)).rejects.toMatchObject(PERMISSION_DENIED);
    const [{ n: before }] = await admin`select count(*)::int as n from echiche.projects`;
    const bobDeleted = await asUser(bob, tx => tx`delete from echiche.projects returning id`);
    expect(bobDeleted).toHaveLength(0); // RLS: Bob's delete matches none of Alice's rows
    const [{ n: after }] = await admin`select count(*)::int as n from echiche.projects`;
    expect(after).toBe(before);
    await expect(asUser(null, tx => tx`delete from echiche.projects returning id`)).resolves.toHaveLength(0);
  });
});

describe("Supabase API roles (Data API / publishable key) have no access", () => {
  it.each(["anon", "authenticated", "service_role"])("%s cannot read, write or see the schema", async role => {
    await expect(asRole(role, tx => tx`select * from echiche.projects`)).rejects.toMatchObject(PERMISSION_DENIED);
    await expect(asRole(role, tx => tx`insert into echiche.projects (owner_user_id, title, problem_statement) values (${alice}, 'x', 'xxxxxxxxxx')`))
      .rejects.toMatchObject(PERMISSION_DENIED);
  });
});

describe("worker role (used from M3)", () => {
  it("reads across owners and records execution facts, but cannot create projects or delete", async () => {
    const seen = await asRole("echiche_worker", tx => tx`select count(*)::int as n from echiche.thought_runs`);
    expect(seen[0].n).toBe(1);
    const updated = await asRole("echiche_worker", tx => tx`update echiche.thought_runs set status = 'failed', error_code = 'RUN_FAILED' where id = ${aliceRun} returning id, completed_at`);
    expect(updated).toHaveLength(1);
    expect(updated[0].completed_at).not.toBeNull(); // maintained by the transition trigger
    await expect(asRole("echiche_worker", tx => tx`update echiche.thought_runs set completed_at = now()`)).rejects.toMatchObject(PERMISSION_DENIED);
    await expect(asRole("echiche_worker", tx => tx`insert into echiche.projects (owner_user_id, title, problem_statement) values (${alice}, 'x', 'xxxxxxxxxx')`))
      .rejects.toMatchObject(PERMISSION_DENIED);
    await expect(asRole("echiche_worker", tx => tx`delete from echiche.run_events`)).rejects.toMatchObject(PERMISSION_DENIED);
    await expect(asRole("echiche_worker", tx => tx`update echiche.thought_runs set prompt = 'rewritten'`)).rejects.toMatchObject(PERMISSION_DENIED);
  });
});
