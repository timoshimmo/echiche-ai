import { runAction } from "@/lib/server/run-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** awaiting_user_review → completed. */
export const POST = runAction("accept", (repo, runId) => repo.acceptRun(runId));
