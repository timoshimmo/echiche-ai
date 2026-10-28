import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser, Memory } from "@/lib/domain/types";
import { resetServerConfigForTests } from "@/lib/server/config";
import { setStoreForTests } from "@/lib/server/container";
import { MemoryStore } from "@/lib/server/memory-repository";

const session = vi.hoisted(() => ({ user: null as CurrentUser | null }));
vi.mock("@/lib/server/auth", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/server/auth")>();
  return { ...actual, getCurrentUser: async () => session.user };
});

const { POST: createProject } = await import("./projects/route");
const { DELETE: deleteProject, GET: getProject } = await import("./projects/[projectId]/route");
const { POST: startRun } = await import("./projects/[projectId]/runs/route");
const { POST: acceptRun } = await import("./runs/[runId]/accept/route");
const { GET: listMemories, POST: addMemory } = await import("./projects/[projectId]/memories/route");
const { PATCH: correctMemory, DELETE: deleteMemory } = await import("./memories/[memoryId]/route");
const { POST: approve } = await import("./memories/[memoryId]/approve/route");
const { POST: reject } = await import("./memories/[memoryId]/reject/route");
const { GET: history } = await import("./memories/[memoryId]/history/route");
const { GET: listDecisions } = await import("./projects/[projectId]/decisions/route");
const { POST: revise } = await import("./decisions/[decisionId]/revise/route");
const { POST: addOutcome } = await import("./decisions/[decisionId]/outcomes/route");
const { GET: exportProject } = await import("./projects/[projectId]/export/route");

const ALICE: CurrentUser = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "alice@example.test" };
const BOB: CurrentUser = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", email: "bob@example.test" };
const ORIGIN = "http://localhost:3000";
const BRIEF = JSON.parse(readFileSync(fileURLToPath(new URL("../../../contracts/fixtures/decision-brief.v1.valid.json", import.meta.url)), "utf8"));

let store: MemoryStore;
const post = (body?: unknown, method = "POST", origin = ORIGIN) =>
  new Request(`${ORIGIN}/x`, { method, headers: { "content-type": "application/json", origin }, body: body === undefined ? undefined : JSON.stringify(body) });
const get = (path = "/x") => new Request(`${ORIGIN}${path}`);
const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });
const data = async (r: Response) => (await r.json()).data;
const code = async (r: Response) => (await r.json()).error.code as string;

async function project(user = ALICE) {
  session.user = user;
  return data(await createProject(post({ title: "Pilot plan", problemStatement: "Should we run a paid pilot?" })));
}

/** A proposal as the worker writes it after a run (status proposed, origin model_proposal). */
function propose(projectId: string, content: string, sensitivity: "normal" | "sensitive" = "normal"): Memory {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const memory: Memory = {
    id, lineageId: id, version: 1, supersedesId: null, kind: "assumption", content, status: "proposed", origin: "model_proposal",
    edited: false, sensitivity, confidence: null, sourceRunId: null, observedAt: now, createdAt: now, reviewedAt: null,
    validFrom: null, validTo: null
  };
  store.memories.set(id, { ...memory, ownerId: ALICE.id, projectId });
  return memory;
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DATABASE_URL", "postgresql://echiche_web:placeholder@localhost:5432/unused");
  vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_placeholder_placeholder");
  vi.stubEnv("APP_ORIGIN", ORIGIN);
  resetServerConfigForTests();
  store = new MemoryStore();
  setStoreForTests(store);
});

describe("memory proposals (MEM-01)", () => {
  it("are not remembered until approved; approval can edit; rejection keeps them out", async () => {
    const proj = await project();
    const a = propose(proj.id, "Clinics will pay 80 dollars per month.");
    const b = propose(proj.id, "Receptionists prefer phone booking.");
    expect(await data(await listMemories(get(), p({ projectId: proj.id })))).toEqual([]); // default: active only
    const proposed = await data(await listMemories(get("/x?status=proposed"), p({ projectId: proj.id })));
    expect(proposed.map((m: Memory) => m.id).sort()).toEqual([a.id, b.id].sort());

    const approved = await data(await approve(post({ content: "Clinics will pay 90 dollars per month." }), p({ memoryId: a.id })));
    expect(approved).toMatchObject({ status: "active", edited: true, content: "Clinics will pay 90 dollars per month.", origin: "model_proposal" });
    expect((await data(await reject(post(), p({ memoryId: b.id })))).status).toBe("rejected");
    expect(await code(await approve(post({}), p({ memoryId: b.id })))).toBe("MEMORY_STATE_CONFLICT");
    const active = await data(await listMemories(get(), p({ projectId: proj.id })));
    expect(active.map((m: Memory) => m.id)).toEqual([a.id]);
  });

  it("require explicit confirmation when they look sensitive", async () => {
    const proj = await project();
    const m = propose(proj.id, "The founder's salary must be covered.", "sensitive");
    const refused = await approve(post({}), p({ memoryId: m.id }));
    expect(refused.status).toBe(409);
    expect(await code(refused)).toBe("SENSITIVE_CONFIRMATION_REQUIRED");
    expect((await data(await approve(post({ confirmSensitive: true }), p({ memoryId: m.id })))).status).toBe("active");
  });
});

describe("corrections, history and deletion (MEM-02)", () => {
  it("a correction supersedes the old version, which stays in history; delete removes every version", async () => {
    const proj = await project();
    const v1 = await data(await addMemory(post({ kind: "goal", content: "Reach 20 paying clinics." }), p({ projectId: proj.id })));
    const v2 = await data(await correctMemory(post({ content: "Reach 40 paying clinics." }, "PATCH"), p({ memoryId: v1.id })));
    expect(v2).toMatchObject({ version: 2, supersedesId: v1.id, lineageId: v1.lineageId, status: "active" });
    expect(await code(await correctMemory(post({ content: "again" }, "PATCH"), p({ memoryId: v1.id })))).toBe("MEMORY_STATE_CONFLICT");
    const lineage = await data(await history(get(), p({ memoryId: v2.id })));
    expect(lineage.map((m: Memory) => [m.version, m.status, m.content])).toEqual([
      [1, "superseded", "Reach 20 paying clinics."],
      [2, "active", "Reach 40 paying clinics."]
    ]);
    expect(await data(await deleteMemory(post(undefined, "DELETE"), p({ memoryId: v2.id })))).toEqual({ deleted: true });
    expect(await data(await listMemories(get("/x?status=all"), p({ projectId: proj.id })))).toEqual([]);
  });

  it("validates input and hides other users' memories behind the same 404", async () => {
    const proj = await project();
    expect(await code(await addMemory(post({ kind: "belief", content: "x" }), p({ projectId: proj.id })))).toBe("VALIDATION_ERROR");
    expect(await code(await addMemory(post({ kind: "goal", content: "x", ownerUserId: BOB.id }), p({ projectId: proj.id })))).toBe("VALIDATION_ERROR");
    expect(await code(await listMemories(get("/x?status=everything"), p({ projectId: proj.id })))).toBe("VALIDATION_ERROR");
    const mine = await data(await addMemory(post({ kind: "goal", content: "Private goal." }), p({ projectId: proj.id })));
    session.user = BOB;
    expect((await listMemories(get(), p({ projectId: proj.id }))).status).toBe(404);
    expect((await correctMemory(post({ content: "hijack" }, "PATCH"), p({ memoryId: mine.id }))).status).toBe(404);
    expect((await deleteMemory(post(undefined, "DELETE"), p({ memoryId: mine.id }))).status).toBe(404);
    expect((await history(get(), p({ memoryId: mine.id }))).status).toBe(404);
  });

  it("rejects cross-origin changes", async () => {
    const proj = await project();
    const response = await addMemory(post({ kind: "goal", content: "x" }, "POST", "https://evil.example"), p({ projectId: proj.id }));
    expect(response.status).toBe(403);
  });
});

describe("decision journal (DEC-01)", () => {
  it("accepting a brief records a decision; revisions append versions and keep the earlier rationale", async () => {
    const proj = await project();
    const run = await data(await startRun(post({ prompt: "Should we run a paid pilot this quarter?" }), p({ projectId: proj.id })));
    store.simulateWorker(run.id, { status: "awaiting_user_review", result: { schemaVersion: "decision-brief.v1", data: BRIEF } });
    await acceptRun(post(), p({ runId: run.id }));
    await acceptRun(post(), p({ runId: run.id })); // idempotent: still one decision
    let journal = await data(await listDecisions(get(), p({ projectId: proj.id })));
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ version: 1, status: "active", origin: "accepted_brief", sourceRunId: run.id, choice: BRIEF.recommendation.summary });

    const v2 = await data(await revise(post({ choice: "Run a free pilot instead.", rationale: "Two clinics declined the price." }), p({ decisionId: journal[0].id })));
    expect(v2).toMatchObject({ version: 2, supersedesId: journal[0].id, origin: "user_revision" });
    expect(await code(await revise(post({ choice: "x", rationale: "y" }), p({ decisionId: journal[0].id })))).toBe("DECISION_STATE_CONFLICT");
    const outcome = await data(await addOutcome(post({ result: "worse", observedOutcome: "Only one clinic converted.", observedOn: "2026-10-01" }), p({ decisionId: v2.id })));
    expect(outcome.result).toBe("worse");
    expect(await code(await addOutcome(post({ result: "worse", observedOutcome: "x", observedOn: "2999-01-01" }), p({ decisionId: v2.id })))).toBe("VALIDATION_ERROR");

    journal = await data(await listDecisions(get(), p({ projectId: proj.id })));
    expect(journal.map((d: { version: number; status: string }) => [d.version, d.status])).toEqual([[2, "active"], [1, "superseded"]]);
    expect(journal[1].rationale).toBe(BRIEF.recommendation.rationale); // the original reason survives
    expect(journal[0].outcomes).toHaveLength(1);
  });
});

describe("export and project deletion (EXPORT-01)", () => {
  it("exports the project's history as a JSON attachment, owner only", async () => {
    const proj = await project();
    await addMemory(post({ kind: "goal", content: "Reach 20 paying clinics." }), p({ projectId: proj.id }));
    const response = await exportProject(get(), p({ projectId: proj.id }));
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="echiche-project-.+\.json"$/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({ schema: "echiche-export.v1", project: { id: proj.id } });
    expect(body.memories).toHaveLength(1);
    session.user = BOB;
    expect((await exportProject(get(), p({ projectId: proj.id }))).status).toBe(404);
  });

  it("deletes a project and everything in it, owner only", async () => {
    const proj = await project();
    await addMemory(post({ kind: "goal", content: "Goal." }), p({ projectId: proj.id }));
    session.user = BOB;
    expect((await deleteProject(post(undefined, "DELETE"), p({ projectId: proj.id }))).status).toBe(404);
    session.user = ALICE;
    expect(await data(await deleteProject(post(undefined, "DELETE"), p({ projectId: proj.id })))).toEqual({ deleted: true });
    expect((await getProject(get(), p({ projectId: proj.id }))).status).toBe(404);
    expect(store.memories.size).toBe(0);
  });
});
