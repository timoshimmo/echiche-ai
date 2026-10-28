import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { RunBudget } from "@/lib/domain/types";
import { adminSql, createTestUser, resetData } from "@/test/db";
import { closePostgresClients, PostgresStore } from "./postgres-repository";
import { DecisionStateError, MemoryStateError, SensitiveConfirmationError } from "./repository";

// Memory and decision journal as echiche_web → echiche_end_user, with RLS and the 0007 triggers.
const admin = adminSql();
const store = new PostgresStore(process.env.DATABASE_URL!);
const BUDGET: RunBudget = { maxSteps: 18, maxActiveSeconds: 600, maxResearchCalls: 8, maxCostUsd: 0.5 };
const BRIEF = JSON.parse(readFileSync(fileURLToPath(new URL("../../../contracts/fixtures/decision-brief.v1.valid.json", import.meta.url)), "utf8"));
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

async function setup() {
  const repo = store.forOwner(alice);
  const project = await repo.createProject({ title: "Pilot plan", problemStatement: "Should we run a paid pilot?" }, 100);
  const { run } = (await repo.createRun(project.id, { prompt: "Should we run a paid pilot this quarter?" }, { maxPerHour: 100, budget: BUDGET, spend: { userDailyUsd: 1000, globalDailyUsd: 10000 } }))!;
  return { repo, project, run };
}

/** Plays the worker: a finished run with a brief, and its memory proposals. */
async function finishWithProposals(runId: string, projectId: string) {
  await admin`update echiche.thought_runs set status = 'awaiting_user_review', result = ${admin.json(BRIEF)},
              result_schema_version = 'decision-brief.v1' where id = ${runId}`;
  const rows = await admin<{ id: string }[]>`
    insert into echiche.memories (owner_user_id, project_id, kind, content, status, origin, sensitivity, source_run_id, proposal_index)
    values (${alice}, ${projectId}, 'assumption', 'Clinics will pay 80 dollars per month.', 'proposed', 'model_proposal', 'normal', ${runId}, 0),
           (${alice}, ${projectId}, 'constraint', 'The founder salary must be covered.', 'proposed', 'model_proposal', 'sensitive', ${runId}, 1)
    returning id`;
  return rows.map(r => r.id);
}

describe("memory journal on real Postgres (RLS + triggers)", () => {
  it("approves, edits, rejects, corrects with history, and hard-deletes a lineage", async () => {
    const { repo, project, run } = await setup();
    const [plain, sensitive] = await finishWithProposals(run.id, project.id);
    expect(await repo.listMemories(project.id, {})).toEqual([]);

    const approved = await repo.approveMemory(plain, { content: "Clinics will pay 90 dollars per month." });
    expect(approved).toMatchObject({ status: "active", edited: true, sourceRunId: run.id });
    await expect(repo.approveMemory(sensitive, {})).rejects.toBeInstanceOf(SensitiveConfirmationError);
    expect((await repo.rejectMemory(sensitive))?.status).toBe("rejected");
    await expect(repo.approveMemory(sensitive, { confirmSensitive: true })).rejects.toBeInstanceOf(MemoryStateError);

    const v2 = await repo.correctMemory(plain, { content: "Clinics will pay 100 dollars per month." });
    expect(v2).toMatchObject({ version: 2, supersedesId: plain, status: "active", origin: "user" });
    await expect(repo.correctMemory(plain, { content: "stale edit" })).rejects.toBeInstanceOf(MemoryStateError);
    const lineage = await repo.memoryHistory(v2!.id);
    expect(lineage?.map(m => [m.version, m.status])).toEqual([[1, "superseded"], [2, "active"]]);
    expect(lineage?.[0].validTo).not.toBeNull();

    expect(await repo.listMemories(project.id, { q: "100 dollars" })).toHaveLength(1);
    expect(await repo.listMemories(project.id, { q: "nothing like this" })).toEqual([]);
    expect(await repo.deleteMemory(v2!.id)).toBe(true);
    const [{ n }] = await admin`select count(*)::int as n from echiche.memories where lineage_id = ${plain}`;
    expect(n).toBe(0); // every version is gone (hard delete)
  });

  it("isolates users: another owner sees, edits and deletes nothing", async () => {
    const { repo, project } = await setup();
    const mine = (await repo.createMemory(project.id, { kind: "goal", content: "Private goal." }))!;
    const other = store.forOwner(bob);
    expect(await other.listMemories(project.id, {})).toBeNull();
    expect(await other.correctMemory(mine.id, { content: "hijack" })).toBeNull();
    expect(await other.deleteMemory(mine.id)).toBe(false);
    expect(await other.memoryHistory(mine.id)).toBeNull();
    expect(await other.exportProject(project.id)).toBeNull();
    expect(await other.deleteProject(project.id)).toBe(false);
    const [{ n }] = await admin`select count(*)::int as n from echiche.memories where id = ${mine.id} and content = 'Private goal.'`;
    expect(n).toBe(1);
  });

  it("records accepted briefs as decision versions, keeps earlier rationale, appends outcomes", async () => {
    const { repo, project, run } = await setup();
    await finishWithProposals(run.id, project.id);
    await repo.acceptRun(run.id);
    await repo.acceptRun(run.id);
    const [v1] = (await repo.listDecisions(project.id))!;
    expect(v1).toMatchObject({ version: 1, status: "active", origin: "accepted_brief", sourceRunId: run.id });
    expect(v1.reviewTriggers).toEqual(BRIEF.what_would_change);

    const v2 = (await repo.reviseDecision(v1.id, { choice: "Free pilot instead.", rationale: "Two clinics declined." }))!;
    await expect(repo.reviseDecision(v1.id, { choice: "x", rationale: "y" })).rejects.toBeInstanceOf(DecisionStateError);
    await repo.addOutcome(v2.id, { result: "mixed", observedOutcome: "One clinic converted.", observedOn: "2026-10-20" });
    const journal = (await repo.listDecisions(project.id))!;
    expect(journal.map(d => [d.version, d.status])).toEqual([[2, "active"], [1, "superseded"]]);
    expect(journal[1].rationale).toBe(BRIEF.recommendation.rationale);
    expect(journal[0].outcomes.map(o => o.result)).toEqual(["mixed"]);

    // Decision versions are immutable even for their owner (only active -> superseded is allowed).
    await expect(admin.begin(async tx => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: alice })}, true)`;
      await tx.unsafe("set local role echiche_end_user");
      await tx`update echiche.decisions set status = 'active' where id = ${v1.id}`;
    })).rejects.toThrow(/immutable/);
  });

  it("exports everything and deletes the project with all dependent rows", async () => {
    const { repo, project, run } = await setup();
    await finishWithProposals(run.id, project.id);
    await repo.acceptRun(run.id);
    await admin`insert into echiche.sources (owner_user_id, run_id, source_key, url, domain, title, retrieved_at, content_sha256,
                  search_query, passages)
                values (${alice}, ${run.id}, 'S1', 'https://example.org/a', 'example.org', 'A', now(), ${"a".repeat(64)}, 'q',
                        ${admin.json([{ passage_id: "S1.p1", text: "Some passage." }])})`;
    const exported = (await repo.exportProject(project.id))!;
    expect(exported).toMatchObject({ schema: "echiche-export.v1", project: { id: project.id } });
    const runs = exported.runs as { id: string; sources: unknown[]; events: unknown[] }[];
    expect(runs[0].id).toBe(run.id);
    expect(runs[0].sources).toHaveLength(1);
    expect(exported.memories as unknown[]).toHaveLength(2);
    expect(exported.decisions as unknown[]).toHaveLength(1);

    expect(await repo.deleteProject(project.id)).toBe(true);
    const [counts] = await admin`
      select (select count(*) from echiche.projects where id = ${project.id})::int as projects,
             (select count(*) from echiche.thought_runs where owner_user_id = ${alice})::int as runs,
             (select count(*) from echiche.sources where owner_user_id = ${alice})::int as sources,
             (select count(*) from echiche.memories where owner_user_id = ${alice})::int as memories,
             (select count(*) from echiche.decisions where owner_user_id = ${alice})::int as decisions`;
    expect(counts).toEqual({ projects: 0, runs: 0, sources: 0, memories: 0, decisions: 0 });
  });
});

describe("retries never duplicate journal writes (M8)", () => {
  it("concurrent accepts of one brief record exactly one decision version", async () => {
    const { repo, project, run } = await setup();
    await finishWithProposals(run.id, project.id);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => repo.acceptRun(run.id)));
    expect(results.every(r => r.status === "fulfilled" && r.value?.status === "completed")).toBe(true);
    const [{ n }] = await admin<{ n: number }[]>`select count(*)::int as n from echiche.decisions where project_id = ${project.id}`;
    expect(n).toBe(1);
  });

  it("a worker retry cannot add the same proposal twice (unique run + proposal index)", async () => {
    const { project, run } = await setup();
    await finishWithProposals(run.id, project.id);
    // What RunStore._insert_proposals does on a retried finish.
    await admin`insert into echiche.memories (owner_user_id, project_id, kind, content, status, origin, sensitivity, source_run_id, proposal_index)
                values (${alice}, ${project.id}, 'assumption', 'Clinics will pay 80 dollars per month.', 'proposed', 'model_proposal', 'normal', ${run.id}, 0)
                on conflict (source_run_id, proposal_index) do nothing`;
    const [{ n }] = await admin<{ n: number }[]>`select count(*)::int as n from echiche.memories where source_run_id = ${run.id}`;
    expect(n).toBe(2);
  });
});
