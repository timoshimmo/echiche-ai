import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { RunBudget } from "@/lib/domain/types";
import { adminSql, createTestUser, resetData } from "@/test/db";
import { closePostgresClients, PostgresStore } from "./postgres-repository";
import { DataIntegrityError, IdempotencyConflictError, ProjectArchivedError, RateLimitError, RunStateError } from "./repository";

const admin = adminSql();
const store = new PostgresStore(process.env.DATABASE_URL!);
const BUDGET: RunBudget = { maxSteps: 18, maxActiveSeconds: 600, maxResearchCalls: 8, maxCostUsd: 0.5 };
const OPTS = { maxPerHour: 100, budget: BUDGET };
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

async function aliceRun(options = OPTS) {
  const repo = store.forOwner(alice);
  const project = await repo.createProject({ title: "Alice plan", problemStatement: "Alice's confidential decision." }, 100);
  const outcome = (await repo.createRun(project.id, { prompt: "Alice's private question here." }, options))!;
  return { repo, project, run: outcome.run };
}

/** Plays the worker's part with an operator connection (the real worker is exercised in the E2E test). */
async function workerSets(runId: string, status: string, extra: Record<string, unknown> = {}) {
  await admin`update echiche.thought_runs set ${admin({ status, ...extra })} where id = ${runId}`;
}

describe("PostgresStore as echiche_web (owner-scoped, real Postgres)", () => {
  it("queues a run with the configured budget and nothing executed", async () => {
    const { repo, project, run } = await aliceRun();
    expect(run).toMatchObject({
      projectId: project.id, status: "queued", result: null, attempt: 0, cancelRequested: false,
      budget: BUDGET, usage: { steps: 0, activeSeconds: 0, researchCalls: 0, costUsd: 0 }, completedStages: []
    });
    expect(await repo.getRun(run.id)).toEqual(run);
    expect(await repo.listEvents(run.id)).toEqual([]);
  });

  it("makes run creation idempotent per owner", async () => {
    const repo = store.forOwner(alice);
    const project = await repo.createProject({ title: "Plan", problemStatement: "Idempotency check text." }, 100);
    const key = "client-retry-0001";
    const first = (await repo.createRun(project.id, { prompt: "Same question twice" }, { ...OPTS, idempotencyKey: key }))!;
    const replay = (await repo.createRun(project.id, { prompt: "Same question twice" }, { ...OPTS, idempotencyKey: key }))!;
    expect(first.created).toBe(true);
    expect(replay).toEqual({ run: first.run, created: false });
    await expect(repo.createRun(project.id, { prompt: "A different question" }, { ...OPTS, idempotencyKey: key }))
      .rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await repo.listRuns(project.id)).toHaveLength(1);

    // Concurrent retries with the same key still create exactly one run.
    const racing = await Promise.all(Array.from({ length: 5 }, () =>
      repo.createRun(project.id, { prompt: "Raced question" }, { ...OPTS, idempotencyKey: "client-retry-0002" })));
    expect(racing.filter(r => r!.created)).toHaveLength(1);
    expect(new Set(racing.map(r => r!.run.id)).size).toBe(1);

    // Keys are per owner: Bob's same key is independent.
    const bobProject = await store.forOwner(bob).createProject({ title: "Bob", problemStatement: "Bob's own decision." }, 100);
    expect((await store.forOwner(bob).createRun(bobProject.id, { prompt: "Same question twice" }, { ...OPTS, idempotencyKey: key }))!.created).toBe(true);
  });

  it("cancels queued runs immediately, requests cancellation of active ones, idempotently", async () => {
    const { repo, run } = await aliceRun();
    expect((await repo.cancelRun(run.id))?.status).toBe("cancelled");
    expect((await repo.cancelRun(run.id))?.status).toBe("cancelled");

    const { run: active } = await aliceRun();
    await workerSets(active.id, "critiquing");
    const requested = await repo.cancelRun(active.id);
    expect(requested).toMatchObject({ status: "critiquing", cancelRequested: true });
    expect(await repo.cancelRun(active.id)).toMatchObject({ cancelRequested: true });

    const { run: review } = await aliceRun();
    await workerSets(review.id, "awaiting_user_review");
    await expect(repo.cancelRun(review.id)).rejects.toBeInstanceOf(RunStateError);
  });

  it("accepts a reviewed run, idempotently; refuses runs not awaiting review", async () => {
    const { repo, run } = await aliceRun();
    await expect(repo.acceptRun(run.id)).rejects.toBeInstanceOf(RunStateError);
    await workerSets(run.id, "awaiting_user_review");
    const accepted = await repo.acceptRun(run.id);
    expect(accepted?.status).toBe("completed");
    expect(accepted?.completedAt).not.toBeNull();
    expect((await repo.acceptRun(run.id))?.status).toBe("completed");
  });

  it("resumes a budget-paused run only by explicitly raising its caps", async () => {
    const { repo, run } = await aliceRun();
    await expect(repo.resumeRun(run.id, BUDGET)).resolves.toMatchObject({ status: "queued" }); // no-op, still queued
    await workerSets(run.id, "paused_for_budget", { error_code: "BUDGET_STEPS", steps_used: 18 });
    const inc: RunBudget = { maxSteps: 9, maxActiveSeconds: 300, maxResearchCalls: 4, maxCostUsd: 0.25 };
    const resumed = await repo.resumeRun(run.id, inc);
    expect(resumed).toMatchObject({ status: "queued", errorCode: null, budget: { maxSteps: 27, maxActiveSeconds: 900, maxResearchCalls: 12, maxCostUsd: 0.75 } });
    const again = await repo.resumeRun(run.id, inc); // idempotent: no double increase
    expect(again?.budget.maxSteps).toBe(27);
    await workerSets(run.id, "failed");
    await expect(repo.resumeRun(run.id, inc)).rejects.toBeInstanceOf(RunStateError);
  });

  it("gives another owner nothing: reads and every action behave as not found", async () => {
    const { project, run } = await aliceRun();
    const asBob = store.forOwner(bob);
    expect(await asBob.getProject(project.id)).toBeNull();
    expect(await asBob.listProjects({ includeArchived: true })).toEqual([]);
    expect(await asBob.getRun(run.id)).toBeNull();
    expect(await asBob.listRuns(project.id)).toEqual([]);
    expect(await asBob.listEvents(run.id)).toEqual([]);
    expect(await asBob.updateProject(project.id, { title: "Hijacked" })).toBeNull();
    expect(await asBob.createRun(project.id, { prompt: "Bob on Alice's project" }, OPTS)).toBeNull();
    expect(await asBob.cancelRun(run.id)).toBeNull();
    expect(await asBob.acceptRun(run.id)).toBeNull();
    expect(await asBob.resumeRun(run.id, BUDGET)).toBeNull();
    expect((await store.forOwner(alice).getRun(run.id))?.status).toBe("queued");
  });

  it("updates, archives and unarchives; archived projects refuse new runs", async () => {
    const { repo, project } = await aliceRun();
    const archived = await repo.updateProject(project.id, { archived: true, title: "Renamed" });
    expect(archived).toMatchObject({ title: "Renamed", problemStatement: project.problemStatement });
    expect(await repo.listProjects({ includeArchived: false })).toEqual([]);
    await expect(repo.createRun(project.id, { prompt: "Archived project run" }, OPTS)).rejects.toBeInstanceOf(ProjectArchivedError);
    expect((await repo.updateProject(project.id, { archived: false }))?.archivedAt).toBeNull();
  });

  it("enforces hourly limits per owner, exactly, under concurrency", async () => {
    const repo = store.forOwner(alice);
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => repo.createProject({ title: `P${i}`, problemStatement: "Concurrent creation test." }, 3))
    );
    expect(attempts.filter(a => a.status === "fulfilled")).toHaveLength(3);
    expect(attempts.filter(a => a.status === "rejected").every(a => (a as PromiseRejectedResult).reason instanceof RateLimitError)).toBe(true);
  });

  it("raises DataIntegrityError for a stored result that breaks its contract", async () => {
    const { repo, run } = await aliceRun();
    await admin`update echiche.thought_runs set status = 'awaiting_user_review', result = ${admin.json({ summary: 42 })},
                result_schema_version = 'reasoning-scaffold.v1' where id = ${run.id}`;
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
});

describe("end to end across languages (ADR-001 D8): web queues → Python worker runs → web reads", () => {
  const workerUrl = process.env.WORKER_TEST_DATABASE_URL;
  const workerDir = fileURLToPath(new URL("../../../worker/", import.meta.url));

  it("completes a queued run with the real worker and the shared result contract", async () => {
    expect(workerUrl, "WORKER_TEST_DATABASE_URL (echiche_worker) is required for the E2E test").toBeTruthy();
    const { repo, run } = await aliceRun();

    const worker = spawnSync("uv", ["run", "--no-sync", "--directory", workerDir, "echiche-worker", "--once"], {
      env: { ...process.env, DATABASE_URL: workerUrl, WORKER_ID: "worker-e2e" }, encoding: "utf8", timeout: 120_000
    });
    expect(worker.status, worker.stderr).toBe(0);

    const done = await repo.getRun(run.id); // parsed with the Zod mirror of the Pydantic contract
    expect(done).toMatchObject({ status: "awaiting_user_review", errorCode: null, attempt: 1 });
    expect(done?.completedStages).toEqual(["planning", "researching", "critiquing", "verifying", "synthesizing"]);
    expect(done?.result?.schemaVersion).toBe("reasoning-scaffold.v1");
    if (done?.result?.schemaVersion !== "reasoning-scaffold.v1") throw new Error("expected the demo scaffold");
    expect(done.result.data.stages.map(s => s.stage)).toEqual(["frame", "challenge", "synthesize"]);
    expect(done.result.data.caveat).toMatch(/No research provider is configured/);
    expect(done.generation).toMatchObject({ mode: "demo", calls: 0, costUsd: 0 });
    const events = await repo.listEvents(run.id);
    expect(events.map(e => e.sequence)).toEqual(events.map((_, i) => i + 1));
    expect(events.at(-1)).toMatchObject({ type: "result", stage: "complete" });

    expect((await repo.acceptRun(run.id))?.status).toBe("completed");
  });

  it("reads a model-generated decision brief and its call telemetry through RLS (scripted model, no network)", async () => {
    const { repo, run } = await aliceRun();
    const bobRepo = store.forOwner(bob);
    const worker = spawnSync("uv", ["run", "--no-sync", "--directory", workerDir, "python", "-m", "tests.e2e_fake_model"], {
      env: { ...process.env, DATABASE_URL: workerUrl }, encoding: "utf8", timeout: 120_000
    });
    expect(worker.status, worker.stderr).toBe(0);

    const done = await repo.getRun(run.id);
    expect(done?.status).toBe("awaiting_user_review");
    if (done?.result?.schemaVersion !== "decision-brief.v1") throw new Error("expected a decision brief");
    expect(done.result.data.recommendation.summary.length).toBeGreaterThan(0);
    expect(done.result.data.citations).toEqual([]);
    expect(done.generation).toMatchObject({ mode: "model", providers: ["openai"], calls: 3, repairs: 0 });
    expect(done.generation.prompts.sort()).toEqual(
      ["decision-brief-synthesis@2.2.0", "decision-critic@2.1.0", "decision-framing@2.1.0"]
    );
    expect(done.generation.costUsd).toBeGreaterThan(0);
    expect(done.usage.costUsd).toBeGreaterThanOrEqual(done.generation.costUsd);
    expect(await bobRepo.getRun(run.id)).toBeNull();
  });

  it("reads research provenance through RLS: sources, verified quotes, citations (local TLS site, no network)", async () => {
    const { repo, run } = await aliceRun();
    const worker = spawnSync("uv", ["run", "--no-sync", "--directory", workerDir, "python", "-m", "tests.e2e_fake_model", "--research"], {
      env: { ...process.env, DATABASE_URL: workerUrl }, encoding: "utf8", timeout: 120_000
    });
    expect(worker.status, worker.stderr).toBe(0);

    const done = await repo.getRun(run.id);
    if (done?.result?.schemaVersion !== "decision-brief.v1") throw new Error("expected a decision brief");
    expect(done.usage.researchCalls).toBe(2);
    const evidence = await repo.getEvidence(run.id);
    expect(evidence.sources.map(s => s.domain)).toEqual(["survey.test", "forum.test", "pilots.test"]);
    expect(evidence.sources.every(s => s.url.startsWith("https://") && s.passages.length >= 1)).toBe(true);
    // Every citation in the brief resolves to a stored source with a verified, supporting quote.
    for (const citation of done.result.data.citations) {
      const source = evidence.sources.find(s => s.sourceId === citation.source_id);
      expect(source, citation.source_id).toBeDefined();
      const backed = evidence.claims.some(c => c.status === "verified" && c.links.some(l =>
        l.sourceId === citation.source_id && l.verdict === "supported" &&
        source!.passages.some(p => p.text.toLowerCase().includes(l.quote.toLowerCase().slice(0, 40)))));
      expect(backed, citation.source_id).toBe(true);
    }
    expect(evidence.claims.some(c => c.contradicted)).toBe(true);
    expect(await store.forOwner(bob).getEvidence(run.id)).toEqual({ sources: [], claims: [] });
  });

  it("carries approved memory into the next run, with provenance (TS approves → worker reads → TS shows)", async () => {
    const { repo, project, run } = await aliceRun();
    const drain = () => spawnSync("uv", ["run", "--no-sync", "--directory", workerDir, "python", "-m", "tests.e2e_fake_model"], {
      env: { ...process.env, DATABASE_URL: workerUrl }, encoding: "utf8", timeout: 120_000
    });
    expect(drain().status).toBe(0);
    const proposals = (await repo.listMemories(project.id, { status: "proposed" }))!;
    expect(proposals.length).toBeGreaterThan(0); // the brief's proposed_memory_updates, not yet remembered
    expect(await repo.listMemories(project.id, {})).toEqual([]);
    await repo.approveMemory(proposals[0].id, {});
    await repo.createMemory(project.id, { kind: "goal", content: "Reach 20 paying clinics by June." });
    await repo.acceptRun(run.id);

    const next = (await repo.createRun(project.id, { prompt: "Should we raise the pilot price next quarter?" }, OPTS))!.run;
    expect(drain().status).toBe(0);
    const remembered = await repo.getRememberedContext(next.id);
    expect(remembered[0]).toMatchObject({ ref: "D1", kind: "decision_record" }); // the accepted decision comes first
    expect(remembered.some(r => r.kind === "goal" && r.content === "Reach 20 paying clinics by June.")).toBe(true);
    expect(remembered.every(r => r.memoryId || r.decisionId)).toBe(true);
    expect(await store.forOwner(bob).getRememberedContext(next.id)).toEqual([]);
  });
});
