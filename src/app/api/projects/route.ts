import { createProjectSchema } from "@/lib/domain/validation";
import { getServerConfig } from "@/lib/server/config";
import { getStore } from "@/lib/server/container";
import { apiError, checkOrigin, handleUnexpected, ok, readJsonBody, requireUser } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "GET|POST /api/projects";

/** The caller's projects. Archived projects are omitted unless ?includeArchived=true. */
export async function GET(request: Request) {
  const auth = await requireUser(ROUTE);
  if ("response" in auth) return auth.response;
  const includeArchived = new URL(request.url).searchParams.get("includeArchived") === "true";
  try {
    return ok(await getStore().forOwner(auth.user.id).listProjects({ includeArchived }));
  } catch (error) {
    return handleUnexpected(error, ROUTE);
  }
}

export async function POST(request: Request) {
  const rejected = checkOrigin(request, ROUTE);
  if (rejected) return rejected;
  const auth = await requireUser(ROUTE);
  if ("response" in auth) return auth.response;
  const body = await readJsonBody(request);
  if ("response" in body) return body.response;
  const parsed = createProjectSchema.safeParse(body.value);
  if (!parsed.success) {
    return apiError("VALIDATION_ERROR", "Provide only a title (2–120 characters) and problem statement (10–5000 characters).", 400);
  }
  try {
    const repo = getStore().forOwner(auth.user.id);
    return ok(await repo.createProject(parsed.data, getServerConfig().limits.projectsPerHour), 201);
  } catch (error) {
    return handleUnexpected(error, ROUTE);
  }
}
