import type { ThoughtRun } from "@/lib/domain/types";
import { resourceIdSchema } from "@/lib/domain/validation";
import { getStore } from "./container";
import { checkOrigin, handleUnexpected, notFound, ok, requireUser } from "./http";
import { log } from "./log";
import type { OwnerScopedRepository } from "./repository";

type Context = { params: Promise<{ runId: string }> };

/**
 * Shared handler for the three user decisions on a run (cancel, accept, resume).
 * Each is idempotent; an action the run's state doesn't allow returns 409 RUN_STATE_CONFLICT.
 * Bodies are ignored: the action is fully described by the URL.
 */
export function runAction(name: "cancel" | "accept" | "resume", act: (repo: OwnerScopedRepository, runId: string) => Promise<ThoughtRun | null>) {
  const route = `POST /api/runs/:runId/${name}`;
  return async function POST(request: Request, context: Context) {
    const rejected = checkOrigin(request, route);
    if (rejected) return rejected;
    const auth = await requireUser(route);
    if ("response" in auth) return auth.response;
    const id = resourceIdSchema.safeParse((await context.params).runId);
    if (!id.success) return notFound("Run");
    try {
      const run = await act(getStore().forOwner(auth.user.id), id.data);
      if (!run) return notFound("Run");
      log("info", `run_${name}`, { route, run_id: run.id, status: run.status });
      return ok(run);
    } catch (error) {
      return handleUnexpected(error, route);
    }
  };
}
