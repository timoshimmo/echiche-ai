import { runAction } from "@/lib/server/run-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Queued/paused runs are cancelled at once; active runs stop at the next stage boundary. */
export const POST = runAction("cancel", (repo, runId) => repo.cancelRun(runId));
