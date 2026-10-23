import { NextResponse } from "next/server";
import { createProjectSchema } from "@/lib/domain/validation";
import { getRepository, persistenceMode } from "@/lib/server/container";

export const runtime = "nodejs";

export async function GET() {
  try {
    const projects = await getRepository().listProjects();
    return NextResponse.json({ data: projects, meta: { persistence: persistenceMode() } });
  } catch (error) {
    return NextResponse.json({ error: { code: "STORAGE_UNAVAILABLE", message: error instanceof Error ? error.message : "Storage unavailable" } }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = createProjectSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: { code: "VALIDATION_ERROR", message: "Provide a title (2–120 characters) and problem statement (10–5000 characters)." } }, { status: 400 });
  }
  try {
    const project = await getRepository().createProject(parsed.data);
    return NextResponse.json({ data: project, meta: { persistence: persistenceMode() } }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: { code: "STORAGE_UNAVAILABLE", message: error instanceof Error ? error.message : "Storage unavailable" } }, { status: 503 });
  }
}
