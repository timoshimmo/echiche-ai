import { resourceIdSchema, startRunSchema } from "@/lib/domain/validation";
import { getServerConfig } from "@/lib/server/config";
import { getStore } from "@/lib/server/container";
import {
  apiError, checkOrigin, handleUnexpected, isStorageUnavailable, notFound, ok, readJsonBody, requireUser
} from "@/lib/server/http";
import { log } from "@/lib/server/log";
import { executeThoughtRun } from "@/lib/server/run-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "GET|POST /api/projects/:projectId/runs";
type Context = { params: Promise<{ projectId: string }> };

export async function GET(_request: Request, context: Context) {
  const auth = await requireUser(ROUTE);
  if ("response" in auth) return auth.response;
  const id = resourceIdSchema.safeParse((await context.params).projectId);
  if (!id.success) return notFound("Project");
  try {
    const repo = getStore().forOwner(auth.user.id);
    if (!(await repo.getProject(id.data))) return notFound("Project");
    return ok(await repo.listRuns(id.data));
  } catch (error) {
    return handleUnexpected(error, ROUTE);
  }
}

export async function POST(request: Request, context: Context) {
  const rejected = checkOrigin(request, ROUTE);
  if (rejected) return rejected;
  const auth = await requireUser(ROUTE);
  if ("response" in auth) return auth.response;
  const id = resourceIdSchema.safeParse((await context.params).projectId);
  if (!id.success) return notFound("Project");
  const body = await readJsonBody(request);
  if ("response" in body) return body.response;
  const parsed = startRunSchema.safeParse(body.value);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "Provide only a prompt of 10–8000 characters.", 400);

  try {
    const repo = getStore().forOwner(auth.user.id);
    const run = await repo.createRun(id.data, parsed.data, getServerConfig().limits.runsPerHour);
    if (!run) return notFound("Project");
    try {
      await executeThoughtRun(repo, run.id);
    } catch (error) {
      if (isStorageUnavailable(error)) return handleUnexpected(error, ROUTE);
      log("error", "run_failed", { route: ROUTE, run_id: run.id, project_id: id.data, error_code: "RUN_FAILED" });
      return apiError("RUN_FAILED", "The thought run could not be completed.", 500);
    }
    const completed = await repo.getRun(run.id);
    return ok({ ...completed, events: await repo.listEvents(run.id) }, 201);
  } catch (error) {
    return handleUnexpected(error, ROUTE);
  }
}
