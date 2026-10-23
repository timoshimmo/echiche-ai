import { NextResponse } from "next/server";
import { resourceIdSchema, startRunSchema } from "@/lib/domain/validation";
import { getRepository, persistenceMode } from "@/lib/server/container";
import { apiError, handleUnexpected, isStorageUnavailable, notFound, readJson } from "@/lib/server/http";
import { log } from "@/lib/server/log";
import { executeThoughtRun } from "@/lib/server/run-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "GET|POST /api/projects/:projectId/runs";
type Context = { params: Promise<{ projectId: string }> };

export async function GET(_request: Request, context: Context) {
  const id = resourceIdSchema.safeParse((await context.params).projectId);
  if (!id.success) return notFound("Project");
  try {
    const repo = getRepository();
    if (!(await repo.getProject(id.data))) return notFound("Project");
    return NextResponse.json({ data: await repo.listRuns(id.data), meta: { persistence: persistenceMode() } });
  } catch (error) {
    return handleUnexpected(error, ROUTE);
  }
}

export async function POST(request: Request, context: Context) {
  const id = resourceIdSchema.safeParse((await context.params).projectId);
  if (!id.success) return notFound("Project");
  const parsed = startRunSchema.safeParse(await readJson(request));
  if (!parsed.success) return apiError("VALIDATION_ERROR", "Prompt must be 10–8000 characters.", 400);

  try {
    const repo = getRepository();
    if (!(await repo.getProject(id.data))) return notFound("Project");
    const run = await repo.createRun(id.data, parsed.data);
    try {
      await executeThoughtRun(repo, run.id);
    } catch (error) {
      if (isStorageUnavailable(error)) return handleUnexpected(error, ROUTE);
      log("error", "run_failed", { route: ROUTE, run_id: run.id, project_id: id.data, error_code: "RUN_FAILED" });
      return apiError("RUN_FAILED", "The thought run could not be completed.", 500);
    }
    const completed = await repo.getRun(run.id);
    return NextResponse.json(
      { data: { ...completed, events: await repo.listEvents(run.id) }, meta: { persistence: persistenceMode() } },
      { status: 201 }
    );
  } catch (error) {
    return handleUnexpected(error, ROUTE);
  }
}
