import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/domain/types";
import { resetServerConfigForTests } from "@/lib/server/config";
import { setStoreForTests } from "@/lib/server/container";
import { MemoryStore } from "@/lib/server/memory-repository";

/** M8 F1 at the HTTP layer: delete-and-recreate does not reset limits; spend ceilings answer 429. */
const session = vi.hoisted(() => ({ user: null as CurrentUser | null }));
vi.mock("@/lib/server/auth", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/server/auth")>()),
  getCurrentUser: async () => session.user
}));
const { POST: createProject } = await import("./projects/route");
const { DELETE: deleteProject } = await import("./projects/[projectId]/route");
const { POST: startRun } = await import("./projects/[projectId]/runs/route");
const { POST: resume } = await import("./runs/[runId]/resume/route");
const { GET: exportProject } = await import("./projects/[projectId]/export/route");
const { POST: addMemory } = await import("./projects/[projectId]/memories/route");

const ORIGIN = "http://localhost:3000";
const ALICE: CurrentUser = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "alice@example.test" };
const BOB: CurrentUser = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", email: "bob@example.test" };
let store: MemoryStore;
const post = (body?: unknown, method = "POST") =>
  new Request(`${ORIGIN}/x`, { method, headers: { origin: ORIGIN, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });
const json = async (r: Response) => r.json() as Promise<{ data?: { id: string }; error?: { code: string } }>;
const newProject = async () => { const r = await json(await createProject(post({ title: "Plan", problemStatement: "Abuse limits at the HTTP layer." }))); if (!r.data) throw new Error(JSON.stringify(r)); return r.data.id; };
const deep = (projectId: string) => startRun(post({ prompt: "Should we commit to this?", depth: "deep" }), p({ projectId }));

function env(extra: Record<string, string>) {
  for (const [k, v] of Object.entries({
    NODE_ENV: "test", DATABASE_URL: "postgresql://echiche_web:placeholder@localhost:5432/unused", SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_placeholder_placeholder", APP_ORIGIN: ORIGIN, ...extra
  })) vi.stubEnv(k, v);
  resetServerConfigForTests();
}

beforeEach(() => {
  vi.unstubAllEnvs();
  store = new MemoryStore();
  setStoreForTests(store);
  session.user = ALICE;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("abuse limits over HTTP (M8 F1)", () => {
  it("deleting the project does not reset the hourly run limit", async () => {
    env({ RUN_CREATE_LIMIT_PER_HOUR: "1" });
    const first = await newProject();
    expect((await deep(first)).status).toBe(202);
    expect((await deleteProject(post(undefined, "DELETE"), p({ projectId: first }))).status).toBe(200);
    const second = await newProject();
    const response = await deep(second);
    expect(response.status).toBe(429);
    expect((await json(response)).error?.code).toBe("RATE_LIMITED");
  });

  it("answers 429 SPEND_LIMIT_REACHED at the user's and the global daily ceiling", async () => {
    env({ USER_DAILY_SPEND_LIMIT_USD: "1", GLOBAL_DAILY_SPEND_LIMIT_USD: "1.5" });
    const a = await newProject();
    expect((await deep(a)).status).toBe(202);
    expect((await deep(a)).status).toBe(202);
    const over = await deep(a);
    expect([over.status, (await json(over)).error?.code, over.headers.get("retry-after")]).toEqual([429, "SPEND_LIMIT_REACHED", "3600"]);
    session.user = BOB;
    const b = await newProject();
    expect((await deep(b)).status).toBe(202); // global 1.5 reached
    expect((await json(await deep(b))).error?.code).toBe("SPEND_LIMIT_REACHED");
  });

  it("a resume that would exceed the ceiling is refused and leaves the run paused", async () => {
    env({ USER_DAILY_SPEND_LIMIT_USD: "0.6" });
    const a = await newProject();
    const run = (await json(await deep(a))).data!;
    store.simulateWorker(run.id, { status: "paused_for_budget", errorCode: "BUDGET_COST" });
    const response = await resume(post(), p({ runId: run.id }));
    expect((await json(response)).error?.code).toBe("SPEND_LIMIT_REACHED");
    expect(store.runs.get(run.id)?.status).toBe("paused_for_budget");
  });

  it("rate-limits exports and journal writes per hour", async () => {
    env({ EXPORT_LIMIT_PER_HOUR: "1", JOURNAL_WRITE_LIMIT_PER_HOUR: "2" });
    const a = await newProject();
    expect((await exportProject(new Request(`${ORIGIN}/x`), p({ projectId: a }))).status).toBe(200);
    expect((await json(await exportProject(new Request(`${ORIGIN}/x`), p({ projectId: a })))).error?.code).toBe("RATE_LIMITED");
    const write = () => addMemory(post({ kind: "fact", content: "A remembered fact." }), p({ projectId: a }));
    expect((await write()).status).toBe(201);
    expect((await write()).status).toBe(201);
    expect((await json(await write())).error?.code).toBe("RATE_LIMITED");
  });
});
