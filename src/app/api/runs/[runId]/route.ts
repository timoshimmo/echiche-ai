import { resourceIdSchema } from "@/lib/domain/validation";
import { getStore } from "@/lib/server/container";
import { handleUnexpected, notFound, ok, requireUser } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "GET /api/runs/:runId";

export async function GET(_request: Request, context: { params: Promise<{ runId: string }> }) {
  const auth = await requireUser(ROUTE);
  if ("response" in auth) return auth.response;
  const id = resourceIdSchema.safeParse((await context.params).runId);
  if (!id.success) return notFound("Run");
  try {
    const repo = getStore().forOwner(auth.user.id);
    const run = await repo.getRun(id.data);
    if (!run) return notFound("Run");
    return ok({ ...run, events: await repo.listEvents(id.data), evidence: await repo.getEvidence(id.data) });
  } catch (error) {
    return handleUnexpected(error, ROUTE);
  }
}
