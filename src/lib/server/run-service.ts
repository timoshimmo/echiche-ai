import { runDeterministicThought } from "@/lib/domain/reasoning";
import type { EchicheRepository } from "./repository";

export async function executeThoughtRun(repo: EchicheRepository, runId: string): Promise<void> {
  const run = await repo.getRun(runId);
  if (!run) throw new Error("RUN_NOT_FOUND");
  const stages = runDeterministicThought(run.prompt);
  await repo.appendEvent({ runId, type: "status", stage: "started", message: "Thinking run started." });
  for (const stage of stages.stages) {
    await repo.appendEvent({ runId, type: "stage", stage: stage.stage, message: stage.title });
  }
  const result = JSON.stringify(stages);
  await repo.completeRun(runId, result);
  await repo.appendEvent({ runId, type: "result", stage: "complete", message: "First-pass synthesis completed." });
}
