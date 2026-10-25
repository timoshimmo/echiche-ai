import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runDeterministicThought } from "@/lib/domain/reasoning";
import { adminSql, createTestUser, resetData } from "@/test/db";
import { closePostgresClients, PostgresStore } from "./postgres-repository";
import { DataIntegrityError, ProjectArchivedError, RateLimitError, RunStateError } from "./repository";
import { executeThoughtRun, RUN_FAILED } from "./run-service";

const admin = adminSql();
const store = new PostgresStore(process.env.DATABASE_URL!);
let alice: string;
let bob: string;

beforeEach(async () => {
  await resetData(admin);
  alice = await createTestUser(admin);
  bob = await createTestUser(admin);
});

afterAll(async () => {
  await resetData(admin);
  await admin.end({ timeout: 5 });
  await closePostgresClients();
});

async function aliceRun() {
  const repo = store.forOwner(alice);
  const project = await repo.createProject({ title: "Alice plan", problemStatement: "Alice's confidential decision." }, 100);
  const run = (await repo.createRun(project.id, { prompt: "Alice's private question here." }, 100))!;
  return { repo, project, run };
}

describe("PostgresStore as echiche_web (owner-scoped, real Postgres)", () => {
  it("round-trips the owner's projects, runs and ordered events", async () => {
    const { repo, project, run } = await aliceRun();
    await executeThoughtRun(repo, run.id);
    expect(await repo.getProject(project.id)).toEqual(project);
    expect((await repo.getRun(run.id))?.status).toBe("succeeded");
    expect((await repo.listEvents(run.id)).map(e => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    const [row] = await admin`select jsonb_typeof(result) as kind, owner_user_id from echiche.thought_runs where id = ${run.id}`;
    expect(row).toEqual({ kind: "object", owner_user_id: alice });
  });

  it("gives another owner nothing: reads return null/empty for every resource", async () => {
    const { project, run } = await aliceRun();
    const asBob = store.forOwner(bob);
    expect(await asBob.getProject(project.id)).toBeNull();
    expect(await asBob.listProjects({ includeArchived: true })).toEqual([]);
    expect(await asBob.getRun(run.id)).toBeNull();
    expect(await asBob.listRuns(project.id)).toEqual([]);
    expect(await asBob.listEvents(run.id)).toEqual([]);
  });

  it("gives another owner nothing: writes are refused and the owner's data is unchanged", async () => {
    const { repo, project, run } = await aliceRun();
    const asBob = store.forOwner(bob);
    expect(await asBob.updateProject(project.id, { title: "Hijacked", archived: true })).toBeNull();
    expect(await asBob.createRun(project.id, { prompt: "Bob on Alice's project" }, 100)).toBeNull();
    await expect(asBob.appendEvent({ runId: run.id, type: "stage", stage: "x", message: "x" })).rejects.toBeInstanceOf(RunStateError);
    await expect(asBob.completeRun(run.id, runDeterministicThought("Bob tries to complete"))).rejects.toBeInstanceOf(RunStateError);
    await expect(asBob.failRun(run.id, RUN_FAILED)).rejects.toBeInstanceOf(RunStateError);

    expect(await repo.getProject(project.id)).toMatchObject({ title: "Alice plan", archivedAt: null });
    expect((await repo.getRun(run.id))?.status).toBe("running");
    expect(await repo.listEvents(run.id)).toEqual([]);
    expect(await repo.listRuns(project.id)).toHaveLength(1);
  });

  it("updates, archives and unarchives; archived projects refuse new runs", async () => {
    const { repo, project } = await aliceRun();
    const archived = await repo.updateProject(project.id, { archived: true, title: "Renamed" });
    expect(archived).toMatchObject({ title: "Renamed", problemStatement: project.problemStatement });
    expect(archived?.archivedAt).not.toBeNull();
    expect(await repo.listProjects({ includeArchived: false })).toEqual([]);
    await expect(repo.createRun(project.id, { prompt: "Archived project run" }, 100)).rejects.toBeInstanceOf(ProjectArchivedError);
    const again = await repo.updateProject(project.id, { archived: true });
    expect(again?.archivedAt).toBe(archived?.archivedAt); // idempotent
    expect((await repo.updateProject(project.id, { archived: false }))?.archivedAt).toBeNull();
  });

  it("enforces hourly limits per owner, exactly, under concurrency", async () => {
    const repo = store.forOwner(alice);
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => repo.createProject({ title: `P${i}`, problemStatement: "Concurrent creation test." }, 3))
    );
    expect(attempts.filter(a => a.status === "fulfilled")).toHaveLength(3);
    expect(attempts.filter(a => a.status === "rejected").every(a => (a as PromiseRejectedResult).reason instanceof RateLimitError)).toBe(true);
    await expect(store.forOwner(bob).createProject({ title: "Bob", problemStatement: "Bob is unaffected." }, 3)).resolves.toBeTruthy();
  });

  it("transitions running → failed only from running, and validates error codes in the database", async () => {
    const { repo, run } = await aliceRun();
    expect(await repo.failRun(run.id, RUN_FAILED)).toMatchObject({ status: "failed", errorCode: RUN_FAILED });
    await expect(repo.failRun(run.id, RUN_FAILED)).rejects.toBeInstanceOf(RunStateError);
    const { run: second } = await aliceRun();
    await expect(repo.failRun(second.id, "not a code; drop table")).rejects.toMatchObject({ code: "23514" });
  });

  it("raises DataIntegrityError for a stored result that breaks its contract", async () => {
    const { repo, run } = await aliceRun();
    await admin`
      update echiche.thought_runs set status = 'succeeded', result = ${admin.json({ summary: 42 })},
             result_schema_version = 'reasoning-scaffold.v1', completed_at = now() where id = ${run.id}`;
    await expect(repo.getRun(run.id)).rejects.toBeInstanceOf(DataIntegrityError);
  });

  it("cascades an account deletion to all of that user's rows", async () => {
    const { project } = await aliceRun();
    await admin`delete from auth.users where id = ${alice}`;
    const [counts] = await admin`
      select (select count(*) from echiche.projects where id = ${project.id})::int as projects,
             (select count(*) from echiche.thought_runs where owner_user_id = ${alice})::int as runs`;
    expect(counts).toEqual({ projects: 0, runs: 0 });
  });

  it("answers the readiness ping", async () => {
    await expect(store.ping()).resolves.toBeUndefined();
  });
});
