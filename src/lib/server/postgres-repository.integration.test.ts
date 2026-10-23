import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runDeterministicThought } from "@/lib/domain/reasoning";
import { closePostgresClients, PostgresRepository } from "./postgres-repository";
import { DataIntegrityError, RunStateError } from "./repository";
import { executeThoughtRun, RUN_FAILED } from "./run-service";

const url = process.env.DATABASE_URL!;
const admin = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
const repo = new PostgresRepository(url);

beforeEach(async () => {
  await admin`truncate projects, thought_runs, run_events cascade`;
});

afterAll(async () => {
  await admin.end({ timeout: 5 });
  await closePostgresClients();
});

async function newRun() {
  const project = await repo.createProject({ title: "Launch plan", problemStatement: "Decide how to validate our first segment." });
  const run = await repo.createRun(project.id, { prompt: "What should we test before launch?" });
  return { project, run };
}

describe("PostgresRepository (real Postgres)", () => {
  it("round-trips projects with ISO timestamps", async () => {
    const project = await repo.createProject({ title: "Pricing", problemStatement: "Choose an initial pricing model." });
    expect(await repo.getProject(project.id)).toEqual(project);
    expect((await repo.listProjects()).map(p => p.id)).toEqual([project.id]);
    expect(project.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(await repo.getProject("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("stores the result as a JSONB object (not a double-encoded string) and reads it back typed", async () => {
    const { run } = await newRun();
    const result = runDeterministicThought("What should we test before launch?");
    const completed = await repo.completeRun(run.id, result);
    expect(completed.result).toEqual(result);

    const [row] = await admin`
      select jsonb_typeof(result) as kind, result->>'summary' as summary, result_schema_version
        from thought_runs where id = ${run.id}`;
    expect(row.kind).toBe("object");
    expect(row.summary).toBe(result.summary);
    expect(row.result_schema_version).toBe("reasoning-scaffold.v1");
  });

  it("assigns strictly increasing event sequence numbers and lists in that order", async () => {
    const { run } = await newRun();
    for (const stage of ["a", "b", "c", "d"]) await repo.appendEvent({ runId: run.id, type: "stage", stage, message: stage });
    const events = await repo.listEvents(run.id);
    expect(events.map(e => [e.sequence, e.stage])).toEqual([[1, "a"], [2, "b"], [3, "c"], [4, "d"]]);
  });

  it("rejects a duplicate (run_id, sequence) at the database level", async () => {
    const { run } = await newRun();
    await repo.appendEvent({ runId: run.id, type: "stage", stage: "a", message: "a" });
    await expect(admin`
      insert into run_events (run_id, sequence, event_type, stage, message) values (${run.id}, 1, 'stage', 'dup', 'dup')
    `).rejects.toMatchObject({ code: "23505" });
  });

  it("executes a full run end to end", async () => {
    const { run } = await newRun();
    await executeThoughtRun(repo, run.id);
    const done = await repo.getRun(run.id);
    expect(done?.status).toBe("succeeded");
    expect(done?.completedAt).not.toBeNull();
    expect((await repo.listEvents(run.id)).map(e => e.stage)).toEqual(["started", "frame", "challenge", "synthesize", "complete"]);
  });

  it("transitions running → failed with an error code, and only from running", async () => {
    const { run } = await newRun();
    const failed = await repo.failRun(run.id, RUN_FAILED);
    expect(failed).toMatchObject({ status: "failed", errorCode: RUN_FAILED, result: null });
    await expect(repo.failRun(run.id, RUN_FAILED)).rejects.toBeInstanceOf(RunStateError);
    await expect(repo.completeRun(run.id, runDeterministicThought("x".repeat(20)))).rejects.toBeInstanceOf(RunStateError);
    expect((await repo.getRun(run.id))?.status).toBe("failed");
  });

  it("rejects malformed error codes at the database level", async () => {
    const { run } = await newRun();
    await expect(repo.failRun(run.id, "not a code; drop table")).rejects.toMatchObject({ code: "23514" });
  });

  it("raises DataIntegrityError instead of returning a result that breaks its contract", async () => {
    const { run } = await newRun();
    await admin`
      update thought_runs set status = 'succeeded', result = ${admin.json({ summary: 42 })},
             result_schema_version = 'reasoning-scaffold.v1', completed_at = now()
       where id = ${run.id}`;
    await expect(repo.getRun(run.id)).rejects.toBeInstanceOf(DataIntegrityError);
  });

  it("answers the readiness ping", async () => {
    await expect(repo.ping()).resolves.toBeUndefined();
  });
});
