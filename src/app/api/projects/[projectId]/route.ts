import { resourceIdSchema, updateProjectSchema } from "@/lib/domain/validation";
import { getStore } from "@/lib/server/container";
import { apiError, checkOrigin, handleUnexpected, notFound, ok, readJsonBody, requireUser } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "GET|PATCH /api/projects/:projectId";
type Context = { params: Promise<{ projectId: string }> };

export async function GET(_request: Request, context: Context) {
  const auth = await requireUser(ROUTE);
  if ("response" in auth) return auth.response;
  const id = resourceIdSchema.safeParse((await context.params).projectId);
  if (!id.success) return notFound("Project");
  try {
    const project = await getStore().forOwner(auth.user.id).getProject(id.data);
    return project ? ok(project) : notFound("Project");
  } catch (error) {
    return handleUnexpected(error, ROUTE);
  }
}

/** Rename, edit the problem statement, archive ({"archived": true}) or unarchive. */
export async function PATCH(request: Request, context: Context) {
  const rejected = checkOrigin(request, ROUTE);
  if (rejected) return rejected;
  const auth = await requireUser(ROUTE);
  if ("response" in auth) return auth.response;
  const id = resourceIdSchema.safeParse((await context.params).projectId);
  if (!id.success) return notFound("Project");
  const body = await readJsonBody(request);
  if ("response" in body) return body.response;
  const parsed = updateProjectSchema.safeParse(body.value);
  if (!parsed.success) {
    return apiError("VALIDATION_ERROR", "Provide at least one of title (2–120), problemStatement (10–5000) or archived (boolean), and nothing else.", 400);
  }
  try {
    const project = await getStore().forOwner(auth.user.id).updateProject(id.data, parsed.data);
    return project ? ok(project) : notFound("Project");
  } catch (error) {
    return handleUnexpected(error, ROUTE);
  }
}
