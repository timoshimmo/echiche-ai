import { NextResponse } from "next/server";
import { getRepository } from "@/lib/server/container";
export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params;
  try {
    const repo = getRepository();
    const run = await repo.getRun(runId);
    if (!run) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Run not found." } }, { status: 404 });
    return NextResponse.json({ data: { ...run, events: await repo.listEvents(runId) } });
  } catch (error) {
    return NextResponse.json({ error: { code: "STORAGE_UNAVAILABLE", message: error instanceof Error ? error.message : "Storage unavailable" } }, { status: 503 });
  }
}
