import { describe, expect, it } from "vitest";
import { MemoryRepository } from "./memory-repository";
import { executeThoughtRun } from "./run-service";

describe("executeThoughtRun", () => {
  it("completes a run and records the bounded workflow stages", async () => {
    const repo = new MemoryRepository();
    const project = await repo.createProject({ title: "Launch plan", problemStatement: "Decide how to validate our first customer segment." });
    const run = await repo.createRun(project.id, { prompt: "What should we test before launching to the first customers?" });

    await executeThoughtRun(repo, run.id);

    const completed = await repo.getRun(run.id);
    const events = await repo.listEvents(run.id);
    expect(completed?.status).toBe("succeeded");
    expect(completed?.result).toBeTruthy();
    expect(events.map(event => event.stage)).toEqual(["started", "frame", "challenge", "synthesize", "complete"]);
  });
});
