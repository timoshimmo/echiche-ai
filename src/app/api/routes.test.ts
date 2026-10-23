import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetServerConfigForTests } from "@/lib/server/config";
import { resetRepositoryForTests } from "@/lib/server/container";
import { GET as health } from "./health/route";
import { GET as listProjects, POST as createProject } from "./projects/route";
import { GET as listRuns, POST as startRun } from "./projects/[projectId]/runs/route";
import { GET as ready } from "./ready/route";
import { GET as getRun } from "./runs/[runId]/route";

const json = (body: unknown) =>
  new Request("http://test.local/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
const UNKNOWN_UUID = "00000000-0000-4000-8000-000000000000";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("ALLOW_IN_MEMORY_DEMO", "true");
  resetServerConfigForTests();
  resetRepositoryForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetServerConfigForTests();
});

async function newProject() {
  const response = await createProject(json({ title: "Launch plan", problemStatement: "Decide how to validate our first customer segment." }));
  expect(response.status).toBe(201);
  return (await response.json()).data as { id: string };
}

describe("API routes (in-memory demo mode)", () => {
  it("creates a project, runs it, and reads the run back with typed result and ordered events", async () => {
    const project = await newProject();
    const started = await startRun(json({ prompt: "What should we test before launch?" }), params({ projectId: project.id }));
    expect(started.status).toBe(201);
    const run = (await started.json()).data;
    expect(run.status).toBe("succeeded");
    expect(typeof run.result).toBe("object");
    expect(run.result.stages).toHaveLength(3);

    const fetched = await (await getRun(new Request("http://test.local"), params({ runId: run.id }))).json();
    expect(fetched.data.events.map((e: { sequence: number }) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(fetched.meta.persistence).toBe("in-memory-demo");

    const runs = await (await listRuns(new Request("http://test.local"), params({ projectId: project.id }))).json();
    expect(runs.data).toHaveLength(1);
  });

  it("returns 400 VALIDATION_ERROR for invalid and malformed bodies", async () => {
    const bad = await createProject(json({ title: "x", problemStatement: "short" }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("VALIDATION_ERROR");

    const malformed = await createProject(new Request("http://test.local", { method: "POST", body: "{not json" }));
    expect(malformed.status).toBe(400);

    const project = await newProject();
    const shortPrompt = await startRun(json({ prompt: "Why?" }), params({ projectId: project.id }));
    expect((await shortPrompt.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 404 NOT_FOUND for malformed and unknown IDs without touching storage", async () => {
    for (const response of [
      await getRun(new Request("http://test.local"), params({ runId: "not-a-uuid" })),
      await getRun(new Request("http://test.local"), params({ runId: UNKNOWN_UUID })),
      await listRuns(new Request("http://test.local"), params({ projectId: "'; drop table projects; --" })),
      await startRun(json({ prompt: "A perfectly valid prompt." }), params({ projectId: UNKNOWN_UUID }))
    ]) {
      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe("NOT_FOUND");
    }
  });

  it("returns 503 CONFIG_INVALID (with no detail leaked) when configuration is invalid", async () => {
    vi.stubEnv("ALLOW_IN_MEMORY_DEMO", "false");
    resetServerConfigForTests();
    const response = await listProjects();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toEqual({ code: "CONFIG_INVALID", message: "The server is not configured correctly." });
    expect((await ready()).status).toBe(503);
  });

  it("never returns raw exception messages to clients", async () => {
    const container = await import("@/lib/server/container");
    vi.spyOn(container, "getRepository").mockImplementation(() => {
      throw Object.assign(new Error('invalid input syntax for type uuid: "secret-user-value"'), { code: "22P02" });
    });
    const response = await listProjects();
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("secret-user-value");
    expect(JSON.parse(text).error.code).toBe("INTERNAL_ERROR");
    const logged = vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(logged).not.toContain("secret-user-value");
  });

  it("maps connection failures to 503 STORAGE_UNAVAILABLE", async () => {
    const container = await import("@/lib/server/container");
    vi.spyOn(container, "getRepository").mockImplementation(() => {
      throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), { code: "ECONNREFUSED" });
    });
    const response = await listProjects();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("10.0.0.5");
  });

  it("serves liveness and readiness", async () => {
    expect((await health().json()).status).toBe("ok");
    const response = await ready();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready", persistence: "in-memory-demo" });
  });
});
