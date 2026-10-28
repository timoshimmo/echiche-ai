import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { RunBudget } from "@/lib/domain/types";
import { adminSql, createTestUser, resetData, webSql } from "@/test/db";
import { closePostgresClients, PostgresStore } from "./postgres-repository";
import { RateLimitError, SpendLimitError } from "./repository";

/**
 * M8 security review, finding F1: abuse limits must survive project deletion, and spend must be
 * bounded per user and globally (real Postgres, as echiche_web → echiche_end_user).
 */
const admin = adminSql();
const web = webSql();
const store = new PostgresStore(process.env.DATABASE_URL!);
const BUDGET: RunBudget = { maxSteps: 18, maxActiveSeconds: 600, maxResearchCalls: 8, maxCostUsd: 0.5 };
const ROOMY = { userDailyUsd: 1000, globalDailyUsd: 10000 };
const DEEP = { prompt: "Should we commit to this?", depth: "deep" as const }; // high tier: cap = min(0.5, 1.0) = 0.5

let alice: string;
let bob: string;
beforeEach(async () => {
  await resetData(admin);
  alice = await createTestUser(admin);
  bob = await createTestUser(admin);
});
afterAll(async () => {
  await resetData(admin);
  await Promise.all([admin.end({ timeout: 5 }), web.end({ timeout: 5 })]);
  await closePostgresClients();
});

const project = (owner: string, maxPerHour = 100) =>
  store.forOwner(owner).createProject({ title: "Plan", problemStatement: "Abuse-limit regression test." }, maxPerHour);

describe("F1: limits survive project deletion", () => {
  it("deleting and recreating projects does not reset the hourly run or project limits", async () => {
    const repo = store.forOwner(alice);
    let runs = 0;
    let rejected: unknown;
    try {
      for (let i = 0; i < 5; i++) {
        const p = await repo.createProject({ title: `P${i}`, problemStatement: "Rate limit bypass attempt." }, 3);
        await repo.createRun(p.id, { prompt: "Should we run the expensive thing?" }, { maxPerHour: 2, budget: BUDGET, spend: ROOMY });
        runs++;
        await repo.deleteProject(p.id);
      }
    } catch (error) {
      rejected = error;
    }
    expect(runs).toBe(2); // before the fix: 5 (one per recreated project)
    expect(rejected).toBeInstanceOf(RateLimitError);
    expect((rejected as RateLimitError).resource).toBe("runs");
    // Projects: 3 created in the hour, the 4th is refused even though all were deleted.
    await project(alice, 3).catch(() => undefined);
    await expect(project(alice, 3)).rejects.toBeInstanceOf(RateLimitError);
  });

  it("deleting a project does not release its reserved spend", async () => {
    const repo = store.forOwner(alice);
    const limits = { userDailyUsd: 1.0, globalDailyUsd: 100 };
    const p = await project(alice);
    await repo.createRun(p.id, DEEP, { maxPerHour: 100, budget: BUDGET, spend: limits });
    await repo.createRun(p.id, DEEP, { maxPerHour: 100, budget: BUDGET, spend: limits });
    await repo.deleteProject(p.id);
    const q = await project(alice);
    await expect(repo.createRun(q.id, DEEP, { maxPerHour: 100, budget: BUDGET, spend: limits })).rejects.toBeInstanceOf(SpendLimitError);
  });
});

describe("F1: daily spend ceilings", () => {
  it("reserves each run's spend cap against the user's ceiling (quick runs reserve their smaller cap)", async () => {
    const repo = store.forOwner(alice);
    const limits = { userDailyUsd: 1.2, globalDailyUsd: 100 };
    const p = await project(alice);
    await repo.createRun(p.id, DEEP, { maxPerHour: 100, budget: BUDGET, spend: limits });       // 0.50
    await repo.createRun(p.id, DEEP, { maxPerHour: 100, budget: BUDGET, spend: limits });       // 1.00
    const err = await repo.createRun(p.id, DEEP, { maxPerHour: 100, budget: BUDGET, spend: limits }).catch(e => e);
    expect(err).toBeInstanceOf(SpendLimitError);
    expect((err as SpendLimitError).scope).toBe("user");
    // A quick run reserves only its tier cap (0.10), which still fits under 1.2.
    const quick = await repo.createRun(p.id, { prompt: "Rewrite our note shorter.", depth: "quick" }, { maxPerHour: 100, budget: BUDGET, spend: limits });
    expect(quick?.run.budget.maxCostUsd).toBe(0.1);
    // Bob is unaffected by Alice's spend.
    const b = await project(bob);
    await expect(store.forOwner(bob).createRun(b.id, DEEP, { maxPerHour: 100, budget: BUDGET, spend: limits })).resolves.toBeTruthy();
  });

  it("enforces the global ceiling across users, exactly, under concurrency", async () => {
    const limits = { userDailyUsd: 100, globalDailyUsd: 2.0 }; // room for 4 deep runs in total
    const [pa, pb] = [await project(alice), await project(bob)];
    const attempts = await Promise.allSettled([
      ...Array.from({ length: 4 }, () => store.forOwner(alice).createRun(pa.id, DEEP, { maxPerHour: 100, budget: BUDGET, spend: limits })),
      ...Array.from({ length: 4 }, () => store.forOwner(bob).createRun(pb.id, DEEP, { maxPerHour: 100, budget: BUDGET, spend: limits }))
    ]);
    expect(attempts.filter(a => a.status === "fulfilled")).toHaveLength(4);
    const refused = attempts.filter((a): a is PromiseRejectedResult => a.status === "rejected");
    expect(refused.every(a => a.reason instanceof SpendLimitError && a.reason.scope === "global")).toBe(true);
  });

  it("reserves a resume's increment; a resume over the ceiling is refused and the run stays paused", async () => {
    const repo = store.forOwner(alice);
    const limits = { userDailyUsd: 0.75, globalDailyUsd: 100 };
    const p = await project(alice);
    const { run } = (await repo.createRun(p.id, DEEP, { maxPerHour: 100, budget: BUDGET, spend: limits }))!; // 0.50 reserved
    await admin`update echiche.thought_runs set status = 'paused_for_budget', error_code = 'BUDGET_COST' where id = ${run.id}`;
    const inc: RunBudget = { maxSteps: 9, maxActiveSeconds: 300, maxResearchCalls: 4, maxCostUsd: 0.25 };
    await expect(repo.resumeRun(run.id, inc, limits)).resolves.toMatchObject({ status: "queued" }); // 0.75 reserved
    await admin`update echiche.thought_runs set status = 'paused_for_budget', error_code = 'BUDGET_COST' where id = ${run.id}`;
    await expect(repo.resumeRun(run.id, inc, limits)).rejects.toBeInstanceOf(SpendLimitError);
    expect((await repo.getRun(run.id))?.status).toBe("paused_for_budget");
  });
});

describe("F1: export and journal-write limits", () => {
  it("rate-limits exports and journal writes per owner and kind", async () => {
    const repo = store.forOwner(alice);
    await repo.recordUsage("export", 2);
    await repo.recordUsage("export", 2);
    await expect(repo.recordUsage("export", 2)).rejects.toMatchObject({ resource: "exports" });
    await repo.recordUsage("journal_write", 1); // a different kind has its own budget
    await expect(repo.recordUsage("journal_write", 1)).rejects.toMatchObject({ resource: "journal changes" });
    await expect(store.forOwner(bob).recordUsage("export", 2)).resolves.toBeUndefined();
  });
});

describe("F1: the ledger holds no content and is owner-scoped", () => {
  const asUser = <T>(user: string, fn: (tx: typeof web) => Promise<T>) =>
    web.begin(async tx => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: user, role: "authenticated" })}, true)`;
      await tx.unsafe("set local role echiche_end_user");
      return fn(tx as unknown as typeof web);
    }) as Promise<T>;

  it("stores only kind, reserved spend and time; users see their own rows and only the global total", async () => {
    const columns = await admin<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_schema = 'echiche' and table_name = 'usage_ledger' order by ordinal_position`;
    expect(columns.map(c => c.column_name)).toEqual(["id", "owner_user_id", "kind", "reserved_cost_usd", "created_at"]);

    const p = await project(alice);
    await store.forOwner(alice).createRun(p.id, DEEP, { maxPerHour: 100, budget: BUDGET, spend: ROOMY });
    expect(await asUser(bob, tx => tx`select * from echiche.usage_ledger`)).toHaveLength(0);
    expect((await asUser(alice, tx => tx`select * from echiche.usage_ledger`)).length).toBeGreaterThan(0);
    const [{ total }] = await asUser(bob, tx => tx<{ total: string }[]>`select echiche.global_reserved_spend(interval '24 hours')::text as total`);
    expect(Number(total)).toBe(0.5);
  });

  it("is append-only for users: no update, no delete, no rows for someone else", async () => {
    await project(alice);
    await expect(asUser(alice, tx => tx`update echiche.usage_ledger set reserved_cost_usd = 0`)).rejects.toThrow(/permission denied/);
    await expect(asUser(alice, tx => tx`delete from echiche.usage_ledger`)).rejects.toThrow(/permission denied/);
    await expect(asUser(alice, tx => tx`insert into echiche.usage_ledger (owner_user_id, kind) values (${bob}, 'project')`))
      .rejects.toThrow(/row-level security/);
  });

  it("survives project deletion but is removed with the account", async () => {
    const p = await project(alice);
    await store.forOwner(alice).deleteProject(p.id);
    const count = async () => (await admin<{ n: number }[]>`select count(*)::int as n from echiche.usage_ledger where owner_user_id = ${alice}`)[0].n;
    expect(await count()).toBe(1);
    await admin`delete from auth.users where id = ${alice}`;
    expect(await count()).toBe(0);
  });
});
