import type { z } from "zod";
import { resourceIdSchema } from "@/lib/domain/validation";
import { getServerConfig } from "./config";
import { getStore } from "./container";
import { apiError, checkOrigin, handleUnexpected, notFound, ok, readJsonBody, requireUser } from "./http";
import { log } from "./log";
import type { OwnerScopedRepository } from "./repository";

type What = "Project" | "Memory" | "Decision";
type Context = { params: Promise<Record<string, string>> };

/**
 * Shared shape of the memory/journal routes (M6): auth, owner-scoped repository, UUID route
 * param (anything else is a plain 404), optional strict JSON body, null result → 404.
 * State-changing methods also require the app origin (CSRF) and a JSON content type.
 */
export function journalRoute<S extends z.ZodType | null>(options: {
  route: string;
  param: string;
  what: What;
  mutating: boolean;
  /** Rate-limited in the usage ledger: every mutating route counts as a journal write; export has its own limit. */
  usage?: "export";
  body: S;
  invalid?: string;
  status?: number;
  act: (repo: OwnerScopedRepository, id: string, input: S extends z.ZodType ? z.infer<S> : undefined, request: Request) => Promise<unknown>;
}) {
  return async function handler(request: Request, context: Context) {
    if (options.mutating) {
      const rejected = checkOrigin(request, options.route);
      if (rejected) return rejected;
    }
    const auth = await requireUser(options.route);
    if ("response" in auth) return auth.response;
    const id = resourceIdSchema.safeParse((await context.params)[options.param]);
    if (!id.success) return notFound(options.what, { route: options.route, userId: auth.user.id });
    let input: unknown = undefined;
    if (options.body) {
      const body = await readJsonBody(request);
      if ("response" in body) return body.response;
      const parsed = options.body.safeParse(body.value);
      if (!parsed.success) return apiError("VALIDATION_ERROR", options.invalid ?? "Invalid or unknown fields in the request body.", 400);
      input = parsed.data;
    }
    try {
      const repo = getStore().forOwner(auth.user.id);
      const limits = getServerConfig().limits;
      if (options.usage === "export") await repo.recordUsage("export", limits.exportsPerHour);
      else if (options.mutating) await repo.recordUsage("journal_write", limits.journalWritesPerHour);
      const result = await options.act(repo, id.data, input as never, request);
      if (result === null || result === false) return notFound(options.what, { route: options.route, userId: auth.user.id });
      // Audit trail (blueprint §8.1): every change, export and deletion, with who and which resource.
      if (options.mutating || options.usage === "export") {
        log("info", options.usage === "export" ? "project_exported" : "journal_change",
          { route: options.route, user_id: auth.user.id, resource: options.what, resource_id: id.data });
      }
      if (result instanceof Response) return result;
      return ok(result === true ? { deleted: true } : result, options.status ?? 200);
    } catch (error) {
      return handleUnexpected(error, options.route);
    }
  };
}
