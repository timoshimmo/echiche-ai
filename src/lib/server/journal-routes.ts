import type { z } from "zod";
import { resourceIdSchema } from "@/lib/domain/validation";
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
    if (!id.success) return notFound(options.what);
    let input: unknown = undefined;
    if (options.body) {
      const body = await readJsonBody(request);
      if ("response" in body) return body.response;
      const parsed = options.body.safeParse(body.value);
      if (!parsed.success) return apiError("VALIDATION_ERROR", options.invalid ?? "Invalid or unknown fields in the request body.", 400);
      input = parsed.data;
    }
    try {
      const result = await options.act(getStore().forOwner(auth.user.id), id.data, input as never, request);
      if (result === null || result === false) return notFound(options.what);
      if (options.mutating) log("info", "journal_change", { route: options.route });
      if (result instanceof Response) return result;
      return ok(result === true ? { deleted: true } : result, options.status ?? 200);
    } catch (error) {
      return handleUnexpected(error, options.route);
    }
  };
}
