import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/domain/types";
import { resetServerConfigForTests } from "@/lib/server/config";
import { setStoreForTests } from "@/lib/server/container";
import { MemoryStore } from "@/lib/server/memory-repository";

/**
 * M8 security review: one access-control matrix over EVERY route handler on disk. Handlers are
 * discovered from the file system, so a new route that is not classified here fails this test.
 *   - private handlers: 401 without a verified session, before touching storage;
 *   - handlers with an ID: another user gets the same 404 as a missing ID, nothing changes,
 *     and the miss is logged with the caller's user ID (audit, F4);
 *   - malformed and guessed IDs: 404.
 */
const session = vi.hoisted(() => ({ user: null as CurrentUser | null }));
vi.mock("@/lib/server/auth", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/server/auth")>()),
  getCurrentUser: async () => session.user
}));

const API = fileURLToPath(new URL(".", import.meta.url));
const APP = fileURLToPath(new URL("..", import.meta.url));
const ORIGIN = "http://localhost:3000";
const ALICE: CurrentUser = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "alice@example.test" };
const BOB: CurrentUser = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", email: "bob@example.test" };
const UNKNOWN = "00000000-0000-4000-8000-000000000000";
const BRIEF = JSON.parse(readFileSync(fileURLToPath(new URL("../../../contracts/fixtures/decision-brief.v1.valid.json", import.meta.url)), "utf8"));
const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;

/** Public handlers (no session needed) and the reason. Everything else must be private. */
const PUBLIC: Record<string, string> = {
  "GET api/health": "liveness",
  "GET api/ready": "readiness",
  "POST auth/sign-in": "password sign-in (ADR-013)",
  "POST auth/sign-up": "creates an account (open sign-up, ADR-013)",
  "POST auth/google": "starts Google sign-in",
  "POST auth/forgot-password": "emails a reset link; same answer for every address",
  "POST auth/update-password": "form route: without a verified session it redirects to sign-in and changes nothing (auth-routes.test.ts)",
  "GET auth/callback": "lands Google, confirmation and reset links",
  "POST auth/sign-out": "clears the caller's own session"
};
/** A valid body per mutating handler, so authorization (not validation) decides the answer. */
const BODIES: Record<string, unknown> = {
  "POST api/projects": { title: "Mine", problemStatement: "A project of the caller's own." },
  "PATCH api/projects/[projectId]": { title: "Hijacked" },
  "POST api/projects/[projectId]/runs": { prompt: "Should we hijack this project?" },
  "POST api/projects/[projectId]/memories": { kind: "fact", content: "Planted by another user." },
  "PATCH api/memories/[memoryId]": { content: "Rewritten by another user." },
  "POST api/memories/[memoryId]/approve": {},
  "POST api/decisions/[decisionId]/revise": { choice: "Hijacked choice", rationale: "Not the owner's." },
  "POST api/decisions/[decisionId]/outcomes": { result: "worse", observedOutcome: "Fake outcome.", observedOn: "2026-10-01" }
};

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
type Entry = { key: string; path: string; method: string; params: string[]; handler: Handler };

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return name === "route.ts" ? [full] : [];
  });
}

async function discover(): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (const file of [...routeFiles(API), ...routeFiles(join(APP, "auth"))]) {
    const path = relative(APP, file).replace(/\/route\.ts$/, "");
    const mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
    for (const method of METHODS) {
      if (typeof mod[method] !== "function") continue;
      entries.push({ key: `${method} ${path}`, path, method, params: [...path.matchAll(/\[(\w+)\]/g)].map(m => m[1]), handler: mod[method] as Handler });
    }
  }
  return entries;
}

let store: MemoryStore;
const logs: string[] = [];

function request(entry: Entry, ids: Record<string, string>): [Request, { params: Promise<Record<string, string>> }] {
  const body = BODIES[entry.key];
  const init: RequestInit = { method: entry.method, headers: { origin: ORIGIN, "content-type": "application/json" } };
  if (entry.method !== "GET" && body !== undefined) init.body = JSON.stringify(body);
  const params: Record<string, string> = {};
  for (const name of entry.params) params[name] = ids[name];
  return [new Request(`${ORIGIN}/${entry.path}`, init), { params: Promise.resolve(params) }];
}

/** Alice's world: a project, an accepted run (so a decision exists) and a proposed + an active memory. */
async function alicesWorld(entries: Entry[]) {
  const find = (key: string) => entries.find(e => e.key === key)!.handler;
  session.user = ALICE;
  const post = (body?: unknown) => new Request(`${ORIGIN}/x`, {
    method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const none = { params: Promise.resolve({}) };
  const project = (await (await find("POST api/projects")(post(BODIES["POST api/projects"]), none)).json()).data;
  const runRes = await find("POST api/projects/[projectId]/runs")(post({ prompt: "Should we run a paid pilot?" }), { params: Promise.resolve({ projectId: project.id }) });
  const run = (await runRes.json()).data;
  store.simulateWorker(run.id, { status: "awaiting_user_review", result: { schemaVersion: "decision-brief.v1", data: BRIEF } });
  await find("POST api/runs/[runId]/accept")(post(), { params: Promise.resolve({ runId: run.id }) });
  const memRes = await find("POST api/projects/[projectId]/memories")(post({ kind: "goal", content: "Alice's goal." }), { params: Promise.resolve({ projectId: project.id }) });
  const memory = (await memRes.json()).data;
  const decision = [...store.decisions.values()][0];
  return { projectId: project.id, runId: run.id, memoryId: memory.id, decisionId: decision.id };
}

const snapshot = () => JSON.stringify({
  projects: [...store.projects.values()], runs: [...store.runs.values()], memories: [...store.memories.values()],
  decisions: [...store.decisions.values()]
});

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
  logs.length = 0;
  vi.spyOn(console, "log").mockImplementation((line: string) => { logs.push(line); });
  vi.spyOn(console, "error").mockImplementation((line: string) => { logs.push(line); });
});

describe("access-control matrix over every route handler (M8)", () => {
  it("finds every handler and classifies each as public or private", async () => {
    const entries = await discover();
    expect(entries.length).toBeGreaterThanOrEqual(28); // 28 handlers at M8; discovery must not silently find fewer
    const unknownPublic = Object.keys(PUBLIC).filter(k => !entries.some(e => e.key === k));
    expect(unknownPublic).toEqual([]); // the public list names real handlers only
  });

  it("every private handler answers 401 without a verified session and stores nothing", async () => {
    const entries = (await discover()).filter(e => !(e.key in PUBLIC));
    const ids = { projectId: UNKNOWN, runId: UNKNOWN, memoryId: UNKNOWN, decisionId: UNKNOWN };
    const wrong: string[] = [];
    for (const entry of entries) {
      const response = await entry.handler(...request(entry, ids));
      if (response.status !== 401) wrong.push(`${entry.key} → ${response.status}`);
    }
    expect(wrong).toEqual([]);
    expect(store.projects.size + store.runs.size + store.memories.size).toBe(0);
  });

  it("another user gets the same 404 as a missing ID on every handler with an ID, changes nothing, and is audited", async () => {
    const entries = await discover();
    const ids = await alicesWorld(entries);
    const before = snapshot();
    session.user = BOB;
    const wrong: string[] = [];
    for (const entry of entries.filter(e => e.params.length > 0)) {
      logs.length = 0;
      const response = await entry.handler(...request(entry, ids));
      const missing = await entry.handler(...request(entry, { projectId: UNKNOWN, runId: UNKNOWN, memoryId: UNKNOWN, decisionId: UNKNOWN }));
      const [a, b] = [await response.text(), await missing.text()];
      if (response.status !== 404 || a !== b) wrong.push(`${entry.key} → ${response.status} ${a.slice(0, 80)}`);
      const audited = logs.some(l => l.includes('"event":"resource_not_found"') && l.includes(BOB.id));
      if (!audited) wrong.push(`${entry.key}: probe not audited`);
    }
    expect(wrong).toEqual([]);
    expect(snapshot()).toBe(before);
  });

  it("malformed IDs get a plain 404 on every handler with an ID", async () => {
    const entries = (await discover()).filter(e => e.params.length > 0);
    session.user = ALICE;
    const wrong: string[] = [];
    for (const bad of ["not-a-uuid", "../../etc/passwd", "1 OR 1=1", "%00"]) {
      for (const entry of entries) {
        const ids = { projectId: bad, runId: bad, memoryId: bad, decisionId: bad };
        const response = await entry.handler(...request(entry, ids));
        if (response.status !== 404) wrong.push(`${entry.key} with ${bad} → ${response.status}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
