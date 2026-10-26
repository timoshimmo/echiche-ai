import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/domain/types";
import { resetServerConfigForTests } from "@/lib/server/config";
import { setStoreForTests } from "@/lib/server/container";
import { MemoryStore } from "@/lib/server/memory-repository";

// The verified-session lookup is the only thing mocked: everything after it is real.
const session = vi.hoisted(() => ({ user: null as CurrentUser | null, unavailable: false }));
vi.mock("@/lib/server/auth", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/server/auth")>();
  return {
    ...actual,
    getCurrentUser: async () => {
      if (session.unavailable) throw new actual.AuthUnavailableError();
      return session.user;
    }
  };
});

const { GET: health } = await import("./health/route");
const { GET: me } = await import("./me/route");
const { GET: listProjects, POST: createProject } = await import("./projects/route");
const { GET: getProject, PATCH: patchProject } = await import("./projects/[projectId]/route");
const { GET: listRuns, POST: startRun } = await import("./projects/[projectId]/runs/route");
const { GET: ready } = await import("./ready/route");
const { GET: getRun } = await import("./runs/[runId]/route");
const { POST: cancelRun } = await import("./runs/[runId]/cancel/route");
const { POST: acceptRun } = await import("./runs/[runId]/accept/route");
const { POST: resumeRun } = await import("./runs/[runId]/resume/route");

const ALICE: CurrentUser = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "alice@example.test" };
const BOB: CurrentUser = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", email: "bob@example.test" };
const UNKNOWN = "00000000-0000-4000-8000-000000000000";
const ORIGIN = "http://localhost:3000";

let store: MemoryStore;

type Init = { body?: unknown; raw?: string; headers?: Record<string, string>; method?: string };
function req(path = "/", { body, raw, headers = {}, method = "POST" }: Init = {}) {
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: payload
  });
}
const get = (path = "/") => new Request(`${ORIGIN}${path}`);
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
const errorCode = async (response: Response) => (await response.json()).error.code as string;

function as(user: CurrentUser | null) {
  session.user = user;
}

async function aliceProjectAndRun() {
  as(ALICE);
  const project = (await (await createProject(req("/api/projects", { body: { title: "Alice plan", problemStatement: "Alice's confidential decision." } }))).json()).data;
  const run = (await (await startRun(req("/", { body: { prompt: "Alice's private question here." } }), params({ projectId: project.id }))).json()).data;
  return { project, run };
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
  session.user = null;
  session.unavailable = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  setStoreForTests(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetServerConfigForTests();
});

describe("authentication (AUTH-01)", () => {
  it("rejects every private route without a verified session, before touching storage", async () => {
    const id = { projectId: UNKNOWN };
    const responses = [
      await me(),
      await listProjects(get("/api/projects")),
      await createProject(req("/", { body: { title: "Nope", problemStatement: "Should never be stored." } })),
      await getProject(get(), params(id)),
      await patchProject(req("/", { method: "PATCH", body: { title: "Nope" } }), params(id)),
      await listRuns(get(), params(id)),
      await startRun(req("/", { body: { prompt: "Should never run at all." } }), params(id)),
      await getRun(get(), params({ runId: UNKNOWN })),
      await cancelRun(req("/"), params({ runId: UNKNOWN })),
      await acceptRun(req("/"), params({ runId: UNKNOWN })),
      await resumeRun(req("/"), params({ runId: UNKNOWN }))
    ];
    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(await errorCode(response)).toBe("UNAUTHENTICATED");
    }
    expect(store.projects.size).toBe(0);
  });

  it("fails closed with 503 AUTH_UNAVAILABLE when the Auth server cannot be reached", async () => {
    session.unavailable = true;
    const response = await listProjects(get("/api/projects"));
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("AUTH_UNAVAILABLE");
  });

  it("returns only the caller's own identity from /api/me", async () => {
    as(ALICE);
    expect((await (await me()).json()).data).toEqual(ALICE);
  });
});

describe("tenant isolation (AUTH-02, PROJ-01)", () => {
  it("lets the owner create, read, update, archive and run their project", async () => {
    const { project, run } = await aliceProjectAndRun();
    expect(run.status).toBe("queued");
    expect((await (await getProject(get(), params({ projectId: project.id }))).json()).data.title).toBe("Alice plan");

    const renamed = await patchProject(req("/", { method: "PATCH", body: { title: "Renamed" } }), params({ projectId: project.id }));
    expect((await renamed.json()).data.title).toBe("Renamed");

    const archived = (await (await patchProject(req("/", { method: "PATCH", body: { archived: true } }), params({ projectId: project.id }))).json()).data;
    expect(archived.archivedAt).not.toBeNull();
    expect((await (await listProjects(get("/api/projects"))).json()).data).toHaveLength(0);
    expect((await (await listProjects(get("/api/projects?includeArchived=true"))).json()).data).toHaveLength(1);

    const blocked = await startRun(req("/", { body: { prompt: "Run on an archived project?" } }), params({ projectId: project.id }));
    expect(blocked.status).toBe(409);
    expect(await errorCode(blocked)).toBe("PROJECT_ARCHIVED");
  });

  it("denies another user every read of the owner's data, indistinguishably from a missing ID", async () => {
    const { project, run } = await aliceProjectAndRun();
    as(BOB);
    expect((await (await listProjects(get("/api/projects?includeArchived=true"))).json()).data).toEqual([]);
    for (const response of [
      await getProject(get(), params({ projectId: project.id })),
      await listRuns(get(), params({ projectId: project.id })),
      await getRun(get(), params({ runId: run.id }))
    ]) {
      expect(response.status).toBe(404);
      expect(await errorCode(response)).toBe("NOT_FOUND");
    }
    const missing = await getRun(get(), params({ runId: UNKNOWN }));
    expect(await missing.json()).toEqual(await (await getRun(get(), params({ runId: run.id }))).json());
  });

  it("denies another user every write to the owner's data and leaves it unchanged", async () => {
    const { project } = await aliceProjectAndRun();
    as(BOB);
    const patch = await patchProject(req("/", { method: "PATCH", body: { title: "Hijacked", archived: true } }), params({ projectId: project.id }));
    expect(patch.status).toBe(404);
    const run = await startRun(req("/", { body: { prompt: "Bob runs on Alice's project" } }), params({ projectId: project.id }));
    expect(run.status).toBe(404);

    as(ALICE);
    const after = (await (await getProject(get(), params({ projectId: project.id }))).json()).data;
    expect(after).toMatchObject({ title: "Alice plan", archivedAt: null });
    expect((await (await listRuns(get(), params({ projectId: project.id }))).json()).data).toHaveLength(1);
  });

  it("ignores client attempts to choose the owner", async () => {
    as(BOB);
    const smuggled = await createProject(req("/", { body: { title: "Mine", problemStatement: "Owner smuggling attempt.", ownerUserId: ALICE.id } }));
    expect(smuggled.status).toBe(400);
    const patch = await patchProject(req("/", { method: "PATCH", body: { ownerUserId: ALICE.id } }), params({ projectId: UNKNOWN }));
    expect(patch.status).toBe(400);
    expect(store.projects.size).toBe(0);
  });

  it("returns 404 for malformed and guessed IDs", async () => {
    as(ALICE);
    for (const response of [
      await getRun(get(), params({ runId: "not-a-uuid" })),
      await getProject(get(), params({ projectId: "'; drop table projects; --" })),
      await getRun(get(), params({ runId: UNKNOWN })),
      await startRun(req("/", { body: { prompt: "A perfectly valid prompt." } }), params({ projectId: UNKNOWN }))
    ]) {
      expect(response.status).toBe(404);
    }
  });
});

describe("request hardening", () => {
  it("rejects cross-origin state changes (CSRF) and accepts same-origin or non-browser requests", async () => {
    as(ALICE);
    const evil = await createProject(req("/", { body: { title: "CSRF", problemStatement: "Created by another site." }, headers: { origin: "https://evil.example" } }));
    expect(evil.status).toBe(403);
    expect(await errorCode(evil)).toBe("FORBIDDEN");
    expect(store.projects.size).toBe(0);

    const noOrigin = new Request(`${ORIGIN}/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "CLI", problemStatement: "Created by a non-browser client." }) });
    expect((await createProject(noOrigin)).status).toBe(201);
  });

  it("rejects non-JSON bodies (blocks text/plain form-post CSRF) with 415", async () => {
    as(ALICE);
    const form = await createProject(req("/", { raw: '{"title":"Form","problemStatement":"Sent as text/plain."}', headers: { "content-type": "text/plain" } }));
    expect(form.status).toBe(415);
    expect(await errorCode(form)).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("rejects oversized bodies with 413, whether or not content-length is declared", async () => {
    as(ALICE);
    const big = JSON.stringify({ title: "Big", problemStatement: "x".repeat(40_000) });
    const declared = await createProject(req("/", { raw: big, headers: { "content-length": String(big.length) } }));
    expect(declared.status).toBe(413);

    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } });
    const undeclared = await createProject(new Request(`${ORIGIN}/`, {
      method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: stream, duplex: "half"
    } as RequestInit));
    expect(undeclared.status).toBe(413);
    expect(await errorCode(undeclared)).toBe("PAYLOAD_TOO_LARGE");
  });

  it("returns 400 for malformed JSON and invalid fields", async () => {
    as(ALICE);
    expect((await createProject(req("/", { raw: "{not json" }))).status).toBe(400);
    expect(await errorCode(await createProject(req("/", { body: { title: "x", problemStatement: "short" } })))).toBe("VALIDATION_ERROR");
    expect((await patchProject(req("/", { method: "PATCH", body: {} }), params({ projectId: UNKNOWN }))).status).toBe(400);
  });

  it("rate-limits run creation per user with 429 and Retry-After, without affecting other users", async () => {
    vi.stubEnv("RUN_CREATE_LIMIT_PER_HOUR", "2");
    resetServerConfigForTests();
    const { project } = await aliceProjectAndRun(); // run 1
    expect((await startRun(req("/", { body: { prompt: "Second run is allowed." } }), params({ projectId: project.id }))).status).toBe(202);
    const third = await startRun(req("/", { body: { prompt: "Third run is limited." } }), params({ projectId: project.id }));
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("3600");
    expect(await errorCode(third)).toBe("RATE_LIMITED");

    as(BOB);
    const bobProject = (await (await createProject(req("/", { body: { title: "Bob plan", problemStatement: "Bob's own decision." } }))).json()).data;
    expect((await startRun(req("/", { body: { prompt: "Bob is not limited by Alice." } }), params({ projectId: bobProject.id }))).status).toBe(202);
  });

  it("never returns raw exception messages to clients or logs", async () => {
    as(ALICE);
    const container = await import("@/lib/server/container");
    vi.spyOn(container, "getStore").mockImplementation(() => {
      throw Object.assign(new Error('invalid input syntax for type uuid: "secret-user-value"'), { code: "22P02" });
    });
    const response = await listProjects(get("/api/projects"));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("secret-user-value");
    expect(JSON.parse(text).error.code).toBe("INTERNAL_ERROR");
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).not.toContain("secret-user-value");
  });

  it("maps database connection failures to 503 STORAGE_UNAVAILABLE", async () => {
    as(ALICE);
    const container = await import("@/lib/server/container");
    vi.spyOn(container, "getStore").mockImplementation(() => {
      throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), { code: "ECONNREFUSED" });
    });
    const response = await listProjects(get("/api/projects"));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("10.0.0.5");
  });

  it("returns 503 CONFIG_INVALID without detail when configuration is invalid", async () => {
    as(ALICE);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "should-never-be-here");
    resetServerConfigForTests();
    const response = await createProject(req("/", { body: { title: "Cfg", problemStatement: "Config is invalid now." } }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "CONFIG_INVALID", message: "The server is not configured correctly." } });
  });
});

describe("health endpoints", () => {
  it("serves liveness and readiness without authentication", async () => {
    expect((await health().json()).status).toBe("ok");
    const response = await ready();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready" });
  });
});

describe("asynchronous runs (M3)", () => {
  it("queues a run and returns 202 with a Location header, without executing it", async () => {
    as(ALICE);
    const project = (await (await createProject(req("/", { body: { title: "Async", problemStatement: "Async run behaviour check." } }))).json()).data;
    const response = await startRun(req("/", { body: { prompt: "What should we test first?" } }), params({ projectId: project.id }));
    expect(response.status).toBe(202);
    const run = (await response.json()).data;
    expect(response.headers.get("location")).toBe(`/api/runs/${run.id}`);
    expect(run).toMatchObject({ status: "queued", result: null, completedStages: [], budget: { maxSteps: 18, maxActiveSeconds: 600 } });
    expect(run.generation).toEqual({
      mode: "demo", providers: [], models: [], prompts: [], calls: 0, repairs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0
    });
    expect(store.events.get(run.id)).toEqual([]);
  });

  it("replays an Idempotency-Key and rejects reuse for a different request", async () => {
    as(ALICE);
    const project = (await (await createProject(req("/", { body: { title: "Idem", problemStatement: "Idempotency key behaviour." } }))).json()).data;
    const headers = { "idempotency-key": "retry-key-0001" };
    const first = await startRun(req("/", { body: { prompt: "Same question here" }, headers }), params({ projectId: project.id }));
    const again = await startRun(req("/", { body: { prompt: "Same question here" }, headers }), params({ projectId: project.id }));
    expect(first.status).toBe(202);
    expect(again.status).toBe(200);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect((await again.json()).data.id).toBe((await first.json()).data.id);
    const conflict = await startRun(req("/", { body: { prompt: "A different question" }, headers }), params({ projectId: project.id }));
    expect(conflict.status).toBe(409);
    expect(await errorCode(conflict)).toBe("IDEMPOTENCY_CONFLICT");
    const bad = await startRun(req("/", { body: { prompt: "Bad key format" }, headers: { "idempotency-key": "no spaces allowed" } }), params({ projectId: project.id }));
    expect(bad.status).toBe(400);
  });

  it("cancels, accepts and resumes according to run state, idempotently", async () => {
    const { run } = await aliceProjectAndRun();
    // queued → cancelled at once
    expect((await (await cancelRun(req("/"), params({ runId: run.id }))).json()).data.status).toBe("cancelled");
    expect((await cancelRun(req("/"), params({ runId: run.id }))).status).toBe(200);
    const notPaused = await resumeRun(req("/"), params({ runId: run.id }));
    expect(notPaused.status).toBe(409);
    expect(await errorCode(notPaused)).toBe("RUN_STATE_CONFLICT");

    const { run: active } = await aliceProjectAndRun();
    store.simulateWorker(active.id, { status: "critiquing" });
    const requested = (await (await cancelRun(req("/"), params({ runId: active.id }))).json()).data;
    expect(requested).toMatchObject({ status: "critiquing", cancelRequested: true });

    const { run: paused } = await aliceProjectAndRun();
    store.simulateWorker(paused.id, { status: "paused_for_budget", errorCode: "BUDGET_STEPS" });
    const resumed = (await (await resumeRun(req("/"), params({ runId: paused.id }))).json()).data;
    expect(resumed).toMatchObject({ status: "queued", errorCode: null, budget: { maxSteps: 27, maxActiveSeconds: 900 } });

    const { run: review } = await aliceProjectAndRun();
    store.simulateWorker(review.id, { status: "awaiting_user_review" });
    expect((await (await acceptRun(req("/"), params({ runId: review.id }))).json()).data.status).toBe("completed");
    expect((await cancelRun(req("/"), params({ runId: review.id }))).status).toBe(409);
  });

  it("denies run actions on another user's run and from another origin", async () => {
    const { run } = await aliceProjectAndRun();
    as(BOB);
    for (const response of [
      await cancelRun(req("/"), params({ runId: run.id })),
      await acceptRun(req("/"), params({ runId: run.id })),
      await resumeRun(req("/"), params({ runId: run.id }))
    ]) {
      expect(response.status).toBe(404);
    }
    as(ALICE);
    const evil = await cancelRun(req("/", { headers: { origin: "https://evil.example" } }), params({ runId: run.id }));
    expect(evil.status).toBe(403);
    expect(store.runs.get(run.id)?.status).toBe("queued");
  });
});
