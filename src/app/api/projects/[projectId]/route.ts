import { resourceIdSchema, updateProjectSchema } from "@/lib/domain/validation";
import { getStore } from "@/lib/server/container";
import { apiError, checkOrigin, handleUnexpected, notFound, ok, readJsonBody, requireUser } from "@/lib/server/http";
import { journalRoute } from "@/lib/server/journal-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "GET|PATCH /api/projects/:projectId";

/** Permanently delete the project and everything in it (runs, sources, memories, decisions). */
export const DELETE = journalRoute({
  route: "DELETE /api/projects/:projectId", param: "projectId", what: "Project", mutating: true, body: null,
  act: (repo, id) => repo.deleteProject(id)
});
type Context = { params: Promise<{ projectId: string }> };

export async function GET(_request: Request, context: Context) {
  const auth = await requireUser(ROUTE);
  if ("response" in auth) return auth.response;
  const id = resourceIdSchema.safeParse((await context.params).projectId);
  if (!id.success) return notFound("Project", { route: ROUTE, userId: auth.user.id });
  try {
    const project = await getStore().forOwner(auth.user.id).getProject(id.data);
    return project ? ok(project) : notFound("Project", { route: ROUTE, userId: auth.user.id });
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
  if (!id.success) return notFound("Project", { route: ROUTE, userId: auth.user.id });
  const body = await readJsonBody(request);
  if ("response" in body) return body.response;
  const parsed = updateProjectSchema.safeParse(body.value);
  if (!parsed.success) {
    return apiError("VALIDATION_ERROR", "Provide at least one of title (2–120), problemStatement (10–5000) or archived (boolean), and nothing else.", 400);
  }
  try {
    const project = await getStore().forOwner(auth.user.id).updateProject(id.data, parsed.data);
    return project ? ok(project) : notFound("Project", { route: ROUTE, userId: auth.user.id });
  } catch (error) {
    return handleUnexpected(error, ROUTE);
  }
}
