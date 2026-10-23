import { NextResponse } from "next/server";
import { resourceIdSchema } from "@/lib/domain/validation";
import { getRepository, persistenceMode } from "@/lib/server/container";
import { handleUnexpected, notFound } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "GET /api/runs/:runId";

export async function GET(_request: Request, context: { params: Promise<{ runId: string }> }) {
  const id = resourceIdSchema.safeParse((await context.params).runId);
  if (!id.success) return notFound("Run");
  try {
    const repo = getRepository();
    const run = await repo.getRun(id.data);
    if (!run) return notFound("Run");
    return NextResponse.json({ data: { ...run, events: await repo.listEvents(id.data) }, meta: { persistence: persistenceMode() } });
  } catch (error) {
    return handleUnexpected(error, ROUTE);
  }
}
