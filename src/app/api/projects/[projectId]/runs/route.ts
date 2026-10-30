import { idempotencyKeySchema, resourceIdSchema, startRunSchema } from "@/lib/domain/validation";
import { getServerConfig } from "@/lib/server/config";
import { getStore } from "@/lib/server/container";
import type { PreparedAttachment, StartRunInput } from "@/lib/domain/types";
import { ATTACHMENT_LIMITS, AttachmentError, checkCounts, prepareFile, prepareLink } from "@/lib/server/attachments";
import { apiError, checkOrigin, handleUnexpected, notFound, ok, readJsonBody, requireUser } from "@/lib/server/http";
import { log } from "@/lib/server/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "GET|POST /api/projects/:projectId/runs";
type Context = { params: Promise<{ projectId: string }> };

export async function GET(_request: Request, context: Context) {
  const auth = await requireUser(ROUTE);
  if ("response" in auth) return auth.response;
  const id = resourceIdSchema.safeParse((await context.params).projectId);
  if (!id.success) return notFound("Project", { route: ROUTE, userId: auth.user.id });
  try {
    const repo = getStore().forOwner(auth.user.id);
    if (!(await repo.getProject(id.data))) return notFound("Project", { route: ROUTE, userId: auth.user.id });
    return ok(await repo.listRuns(id.data));
  } catch (error) {
    return handleUnexpected(error, ROUTE);
  }
}

/**
 * Queues a run and returns 202 immediately; the Python worker executes it (ADR-006).
 * Poll GET /api/runs/:id for progress. An optional `Idempotency-Key` header makes
 * retries safe: the same key + same body returns the original run (200, Idempotent-Replayed).
 */
export async function POST(request: Request, context: Context) {
  const rejected = checkOrigin(request, ROUTE);
  if (rejected) return rejected;
  const auth = await requireUser(ROUTE);
  if ("response" in auth) return auth.response;
  const id = resourceIdSchema.safeParse((await context.params).projectId);
  if (!id.success) return notFound("Project", { route: ROUTE, userId: auth.user.id });

  const rawKey = request.headers.get("idempotency-key");
  const key = rawKey === null ? undefined : idempotencyKeySchema.safeParse(rawKey);
  if (key && !key.success) {
    return apiError("VALIDATION_ERROR", "Idempotency-Key must be 8–128 characters of letters, digits, '.', '_', ':' or '-'.", 400);
  }
  const isMultipart = /^multipart\/form-data\s*;/i.test(request.headers.get("content-type") ?? "");
  const input = isMultipart ? await readMultipart(request) : await readJson(request);
  if ("response" in input) return input.response;

  try {
    const config = getServerConfig();
    const outcome = await getStore().forOwner(auth.user.id).createRun(id.data, input.value, {
      maxPerHour: config.limits.runsPerHour,
      budget: config.runBudget.initial,
      spend: config.spend,
      idempotencyKey: key?.data
    });
    if (!outcome) return notFound("Project", { route: ROUTE, userId: auth.user.id });
    if (!outcome.created) return ok(outcome.run, 200, { "idempotent-replayed": "true" });
    log("info", "run_queued", { route: ROUTE, user_id: auth.user.id, run_id: outcome.run.id, project_id: id.data, tier: outcome.run.route.tier,
      attachments: outcome.run.attachments.length });
    return ok(outcome.run, 202, { location: `/api/runs/${outcome.run.id}` });
  } catch (error) {
    return handleUnexpected(error, ROUTE);
  }
}

const PROMPT_RULE = "Provide a prompt of 10–8000 characters and, optionally, depth (auto, quick, standard or deep).";

async function readJson(request: Request): Promise<{ value: StartRunInput } | { response: Response }> {
  const body = await readJsonBody(request);
  if ("response" in body) return body;
  const parsed = startRunSchema.safeParse(body.value);
  return parsed.success ? { value: parsed.data } : { response: apiError("VALIDATION_ERROR", PROMPT_RULE, 400) };
}

/**
 * ADR-012: a question with attachments arrives as multipart/form-data: `prompt`, optional `depth`, any
 * number of `files` and `links` (within the limits). The size is checked from Content-Length before the
 * body is read, so an oversized upload is refused without buffering it.
 */
async function readMultipart(request: Request): Promise<{ value: StartRunInput } | { response: Response }> {
  // Unlike JSON, a multipart body can be sent by a plain HTML form on another site. checkOrigin already
  // rejects a foreign Origin; here a missing Origin is refused too, since browsers always send one.
  if (request.headers.get("origin") === null) {
    return { response: apiError("FORBIDDEN", "Uploads must come from the Echiche app.", 403) };
  }
  const declared = Number(request.headers.get("content-length") ?? NaN);
  if (!Number.isFinite(declared)) return { response: apiError("VALIDATION_ERROR", "Uploads must declare their size (Content-Length).", 411) };
  if (declared > ATTACHMENT_LIMITS.maxBodyBytes) {
    return { response: apiError("PAYLOAD_TOO_LARGE", "Attachments are too large: up to 5 files of 5 MB each (images 4 MB).", 413) };
  }
  let form: FormData;
  try { form = await request.formData(); } catch {
    return { response: apiError("VALIDATION_ERROR", "The upload could not be read. Try attaching the files again.", 400) };
  }
  const allowed = new Set(["prompt", "depth", "files", "links"]);
  if ([...form.keys()].some(k => !allowed.has(k))) return { response: apiError("VALIDATION_ERROR", "Unexpected form field.", 400) };
  const depth = form.get("depth");
  const parsed = startRunSchema.safeParse({ prompt: form.get("prompt"), ...(typeof depth === "string" && depth ? { depth } : {}) });
  if (!parsed.success) return { response: apiError("VALIDATION_ERROR", PROMPT_RULE, 400) };

  const files = form.getAll("files");
  const links = form.getAll("links").filter((l): l is string => typeof l === "string" && l.trim() !== "");
  if (files.some(f => typeof f === "string")) return { response: apiError("VALIDATION_ERROR", "Files must be uploaded as files.", 400) };
  try {
    const blobs = files as File[];
    const images = blobs.filter(f => f.type.startsWith("image/")).length;
    checkCounts(blobs.length, links.length, images);
    const attachments: PreparedAttachment[] = [];
    let position = 1;
    for (const file of blobs) {
      if (file.size > ATTACHMENT_LIMITS.maxFileBytes) throw new AttachmentError(`“${file.name.slice(0, 80)}” is larger than 5 MB.`);
      attachments.push(await prepareFile(file.name, Buffer.from(await file.arrayBuffer()), position++));
    }
    checkCounts(blobs.length, links.length, attachments.filter(a => a.kind === "image").length);
    for (const link of links) attachments.push(prepareLink(link, position++));
    return { value: { ...parsed.data, attachments } };
  } catch (error) {
    if (error instanceof AttachmentError) return { response: apiError("VALIDATION_ERROR", error.message, 400) };
    throw error;
  }
}
