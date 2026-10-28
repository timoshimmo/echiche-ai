import { getServerConfig } from "@/lib/server/config";
import { runAction } from "@/lib/server/run-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** paused_for_budget → queued with a bounded budget increase: the user's explicit approval. */
export const POST = runAction("resume", (repo, runId) => {
  const config = getServerConfig();
  return repo.resumeRun(runId, config.runBudget.resumeIncrement, config.spend);
});
