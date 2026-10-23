import { NextResponse } from "next/server";
import { startRunSchema } from "@/lib/domain/validation";
import { getRepository, persistenceMode } from "@/lib/server/container";
import { executeThoughtRun } from "@/lib/server/run-service";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await context.params;
  try {
    const repo = getRepository();
    if (!(await repo.getProject(projectId))) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Project not found." } }, { status: 404 });
    return NextResponse.json({ data: await repo.listRuns(projectId), meta: { persistence: persistenceMode() } });
  } catch (error) {
    return NextResponse.json({ error: { code: "STORAGE_UNAVAILABLE", message: error instanceof Error ? error.message : "Storage unavailable" } }, { status: 503 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = startRunSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: { code: "VALIDATION_ERROR", message: "Prompt must be 10–8000 characters." } }, { status: 400 });

  try {
    const repo = getRepository();
    if (!(await repo.getProject(projectId))) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Project not found." } }, { status: 404 });
    const run = await repo.createRun(projectId, parsed.data);
    try {
      await executeThoughtRun(repo, run.id);
    } catch (error) {
      await repo.appendEvent({ runId: run.id, type: "error", stage: "execution", message: error instanceof Error ? error.message : "Run failed" });
      return NextResponse.json({ error: { code: "RUN_FAILED", message: "The thought run could not be completed." } }, { status: 500 });
    }
    return NextResponse.json({ data: { ...(await repo.getRun(run.id)), events: await repo.listEvents(run.id) }, meta: { persistence: persistenceMode() } }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: { code: "STORAGE_UNAVAILABLE", message: error instanceof Error ? error.message : "Storage unavailable" } }, { status: 503 });
  }
}
