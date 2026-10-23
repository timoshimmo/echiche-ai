import { NextResponse } from "next/server";
import { createProjectSchema } from "@/lib/domain/validation";
import { getRepository, persistenceMode } from "@/lib/server/container";
import { apiError, handleUnexpected, readJson } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "GET|POST /api/projects";

export async function GET() {
  try {
    const projects = await getRepository().listProjects();
    return NextResponse.json({ data: projects, meta: { persistence: persistenceMode() } });
  } catch (error) {
    return handleUnexpected(error, ROUTE);
  }
}

export async function POST(request: Request) {
  const parsed = createProjectSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return apiError("VALIDATION_ERROR", "Provide a title (2–120 characters) and problem statement (10–5000 characters).", 400);
  }
  try {
    const project = await getRepository().createProject(parsed.data);
    return NextResponse.json({ data: project, meta: { persistence: persistenceMode() } }, { status: 201 });
  } catch (error) {
    return handleUnexpected(error, ROUTE);
  }
}
