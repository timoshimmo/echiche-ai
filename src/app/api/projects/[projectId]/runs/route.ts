import { idempotencyKeySchema, resourceIdSchema, startRunSchema } from "@/lib/domain/validation";
import { getServerConfig } from "@/lib/server/config";
import { getStore } from "@/lib/server/container";
import { apiError, checkOrigin, handleUnexpected, notFound, ok, readJsonBody, requireUser } from "@/lib/server/http";
import { log } from "@/lib/server/log";

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

/**
 * Queues a run and returns 202 immediately; the Python worker executes it (ADR-006).
 * Poll GET /api/runs/:id for progress. An optional `Idempotency-Key` header makes
 * retries safe: the same key + same body returns the original run (200, Idempotent-Replayed).
 */
export async function POST(request: Request, context: Context) {
  const rejected = checkOrigin(request, ROUTE);
  if (rejected) return rejected;
  const auth = await requireUser(ROUTE);
  if ("response" in auth) return auth.response;
  const id = resourceIdSchema.safeParse((await context.params).projectId);
  if (!id.success) return notFound("Project");

  const rawKey = request.headers.get("idempotency-key");
  const key = rawKey === null ? undefined : idempotencyKeySchema.safeParse(rawKey);
  if (key && !key.success) {
    return apiError("VALIDATION_ERROR", "Idempotency-Key must be 8–128 characters of letters, digits, '.', '_', ':' or '-'.", 400);
  }
  const body = await readJsonBody(request);
  if ("response" in body) return body.response;
  const parsed = startRunSchema.safeParse(body.value);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "Provide only a prompt of 10–8000 characters.", 400);

  try {
    const config = getServerConfig();
    const outcome = await getStore().forOwner(auth.user.id).createRun(id.data, parsed.data, {
      maxPerHour: config.limits.runsPerHour,
      budget: config.runBudget.initial,
      idempotencyKey: key?.data
    });
    if (!outcome) return notFound("Project");
    if (!outcome.created) return ok(outcome.run, 200, { "idempotent-replayed": "true" });
    log("info", "run_queued", { route: ROUTE, run_id: outcome.run.id, project_id: id.data });
    return ok(outcome.run, 202, { location: `/api/runs/${outcome.run.id}` });
  } catch (error) {
    return handleUnexpected(error, ROUTE);
  }
}
