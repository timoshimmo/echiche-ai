import { runDeterministicThought } from "@/lib/domain/reasoning";
import type { EchicheRepository } from "./repository";

export const RUN_FAILED = "RUN_FAILED";

/**
 * Synchronous scaffold execution. Replaced by the Python worker in M3 (ADR-001).
 * Guarantees: a run never stays "running" after this function settles, and
 * "succeeded" is only written after every stage event has been persisted.
 */
export async function executeThoughtRun(repo: EchicheRepository, runId: string): Promise<void> {
  const run = await repo.getRun(runId);
  if (!run) throw new Error("RUN_NOT_FOUND");
  try {
    const result = runDeterministicThought(run.prompt);
    await repo.appendEvent({ runId, type: "status", stage: "started", message: "Thinking run started." });
    for (const stage of result.stages) {
      await repo.appendEvent({ runId, type: "stage", stage: stage.stage, message: stage.title });
    }
    await repo.appendEvent({ runId, type: "result", stage: "complete", message: "First-pass synthesis completed." });
    await repo.completeRun(runId, result);
  } catch (error) {
    // Best effort: record the failure. If storage itself is down this may also fail;
    // the original error is still rethrown so the caller reports RUN_FAILED.
    try {
      await repo.appendEvent({ runId, type: "error", stage: "execution", message: "Run failed." });
      await repo.failRun(runId, RUN_FAILED);
    } catch {
      /* swallowed deliberately; see comment above */
    }
    throw error;
  }
}
