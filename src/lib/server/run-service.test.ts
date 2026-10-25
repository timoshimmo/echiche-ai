import { describe, expect, it } from "vitest";
import { MemoryStore } from "./memory-repository";
import { RunStateError } from "./repository";
import { executeThoughtRun, RUN_FAILED } from "./run-service";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

async function setup() {
  const store = new MemoryStore();
  const repo = store.forOwner(OWNER);
  const project = await repo.createProject({ title: "Launch plan", problemStatement: "Decide how to validate our first customer segment." }, 100);
  const run = (await repo.createRun(project.id, { prompt: "What should we test before launching to the first customers?" }, 100))!;
  return { store, repo, run };
}

describe("executeThoughtRun", () => {
  it("completes a run with a structured result and ordered stage events", async () => {
    const { repo, run } = await setup();
    await executeThoughtRun(repo, run.id);

    const completed = await repo.getRun(run.id);
    const events = await repo.listEvents(run.id);
    expect(completed?.status).toBe("succeeded");
    expect(completed?.errorCode).toBeNull();
    expect(completed?.result?.stages.map(s => s.stage)).toEqual(["frame", "challenge", "synthesize"]);
    expect(events.map(e => e.stage)).toEqual(["started", "frame", "challenge", "synthesize", "complete"]);
    expect(events.map(e => e.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it("cannot execute another owner's run", async () => {
    const { store, run } = await setup();
    await expect(executeThoughtRun(store.forOwner(OTHER), run.id)).rejects.toThrow("RUN_NOT_FOUND");
    expect((await store.forOwner(OWNER).getRun(run.id))?.status).toBe("running");
  });

  it("marks the run failed (never left running) when a write fails mid-run", async () => {
    const { repo, run } = await setup();
    let calls = 0;
    const original = repo.appendEvent.bind(repo);
    repo.appendEvent = async input => {
      calls += 1;
      if (calls === 3) throw new Error("simulated storage write failure");
      return original(input);
    };

    await expect(executeThoughtRun(repo, run.id)).rejects.toThrow("simulated storage write failure");
    const failed = await repo.getRun(run.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.errorCode).toBe(RUN_FAILED);
    expect(failed?.result).toBeNull();
    expect(failed?.completedAt).not.toBeNull();
    expect((await repo.listEvents(run.id)).at(-1)).toMatchObject({ type: "error", stage: "execution" });
  });

  it("marks the run failed when the final completion write fails", async () => {
    const { repo, run } = await setup();
    repo.completeRun = async () => { throw new Error("simulated commit failure"); };
    await expect(executeThoughtRun(repo, run.id)).rejects.toThrow("simulated commit failure");
    expect((await repo.getRun(run.id))?.status).toBe("failed");
  });

  it("still rethrows the original error if recording the failure also fails", async () => {
    const { repo, run } = await setup();
    repo.completeRun = async () => { throw new Error("primary"); };
    repo.failRun = async () => { throw new Error("secondary"); };
    await expect(executeThoughtRun(repo, run.id)).rejects.toThrow("primary");
  });
});

describe("MemoryStore run transitions", () => {
  it("rejects completing or failing a run that is not running", async () => {
    const { repo, run } = await setup();
    await executeThoughtRun(repo, run.id);
    await expect(repo.failRun(run.id, RUN_FAILED)).rejects.toBeInstanceOf(RunStateError);
    await expect(repo.completeRun(run.id, (await repo.getRun(run.id))!.result!)).rejects.toBeInstanceOf(RunStateError);
    expect((await repo.getRun(run.id))?.status).toBe("succeeded");
  });

  it("refuses an owner ID that is not a UUID", () => {
    expect(() => new MemoryStore().forOwner("not-a-uuid")).toThrow(/UUID/);
  });
});
