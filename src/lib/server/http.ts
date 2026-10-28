import { NextResponse } from "next/server";
import type { CurrentUser } from "@/lib/domain/types";
import { AuthUnavailableError, getCurrentUser } from "./auth";
import { ConfigError, getServerConfig } from "./config";
import { log } from "./log";
import {
  DecisionStateError, IdempotencyConflictError, MemoryStateError, ProjectArchivedError, RateLimitError, RunStateError,
  SensitiveConfirmationError, SpendLimitError
} from "./repository";

/** Stable, client-facing error codes (blueprint §6.2). Messages are fixed strings, never raw exception text. */
export type ApiErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "PROJECT_ARCHIVED"
  | "RUN_STATE_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "MEMORY_STATE_CONFLICT"
  | "DECISION_STATE_CONFLICT"
  | "SENSITIVE_CONFIRMATION_REQUIRED"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "RATE_LIMITED"
  | "SPEND_LIMIT_REACHED"
  | "RUN_FAILED"
  | "CONFIG_INVALID"
  | "AUTH_UNAVAILABLE"
  | "STORAGE_UNAVAILABLE"
  | "INTERNAL_ERROR";

const NO_STORE = { "cache-control": "no-store" };

export function apiError(code: ApiErrorCode, message: string, status: number, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status, headers: { ...NO_STORE, ...headers } });
}

export function ok(data: unknown, status = 200, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json({ data }, { status, headers: { ...NO_STORE, ...headers } });
}

/**
 * Another owner's resource and a nonexistent one get the same answer. With `audit`, the miss is
 * logged with the caller's (pseudonymous) user ID, so repeated probing of IDs is visible to the
 * operator (blueprint §8.1: audit permission denials; M8 F4). Never logs the requested ID's owner.
 */
export function notFound(what: "Project" | "Run" | "Memory" | "Decision", audit?: { route: string; userId: string }) {
  if (audit) log("warn", "resource_not_found", { route: audit.route, user_id: audit.userId, resource: what });
  return apiError("NOT_FOUND", `${what} not found.`, 404);
}

const CONNECTION_ERROR_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "CONNECT_TIMEOUT", "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED"]);

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
  return undefined;
}

/** True for failures where the database could not be reached (vs. a bug or bad query). */
export function isStorageUnavailable(error: unknown): boolean {
  const code = errorCodeOf(error);
  if (!code) return false;
  // SQLSTATE class 08 = connection exception; 57P0x = admin/crash shutdown; 53300 = too many connections.
  return CONNECTION_ERROR_CODES.has(code) || code.startsWith("08") || code.startsWith("57P0") || code === "53300";
}

/**
 * Maps an error to a safe response and logs it without its message
 * (driver messages can echo user-supplied values).
 */
export function handleUnexpected(error: unknown, route: string): NextResponse {
  const errorName = error instanceof Error ? error.name : typeof error;
  const errorCode = errorCodeOf(error);

  if (error instanceof RateLimitError) {
    log("warn", "rate_limited", { route, resource: error.resource });
    return apiError("RATE_LIMITED", `Too many new ${error.resource} in the last hour. Try again later.`, 429, { "retry-after": String(error.retryAfterSeconds) });
  }
  if (error instanceof SpendLimitError) {
    log("warn", "spend_limited", { route, scope: error.scope });
    return apiError(
      "SPEND_LIMIT_REACHED",
      error.scope === "user"
        ? "You've reached today's spending limit for runs. Try again later."
        : "Echiche has reached today's overall spending limit. Try again later.",
      429, { "retry-after": "3600" }
    );
  }
  if (error instanceof RunStateError) {
    return apiError("RUN_STATE_CONFLICT", "That action isn't available for this run in its current state.", 409);
  }
  if (error instanceof MemoryStateError) {
    return apiError("MEMORY_STATE_CONFLICT", "That action isn't available for this memory in its current state.", 409);
  }
  if (error instanceof DecisionStateError) {
    return apiError("DECISION_STATE_CONFLICT", "Only the current decision can be revised; earlier versions are kept as history.", 409);
  }
  if (error instanceof SensitiveConfirmationError) {
    return apiError("SENSITIVE_CONFIRMATION_REQUIRED", "This proposal may contain sensitive personal information. Confirm explicitly to save it.", 409);
  }
  if (error instanceof IdempotencyConflictError) {
    return apiError("IDEMPOTENCY_CONFLICT", "This Idempotency-Key was already used for a different request.", 409);
  }
  if (error instanceof ProjectArchivedError) {
    return apiError("PROJECT_ARCHIVED", "This project is archived. Unarchive it to start a run.", 409);
  }
  if (error instanceof ConfigError) {
    // ConfigError messages name variables, never values, so they are safe to log.
    log("error", "config_invalid", { route, issues: error.issues });
    return apiError("CONFIG_INVALID", "The server is not configured correctly.", 503);
  }
  if (error instanceof AuthUnavailableError) {
    log("error", "auth_unavailable", { route });
    return apiError("AUTH_UNAVAILABLE", "Sign-in service is temporarily unavailable.", 503);
  }
  if (isStorageUnavailable(error)) {
    log("error", "storage_unavailable", { route, errorName, errorCode });
    return apiError("STORAGE_UNAVAILABLE", "Storage is temporarily unavailable.", 503);
  }
  log("error", "request_failed", { route, errorName, errorCode });
  return apiError("INTERNAL_ERROR", "Something went wrong.", 500);
}

/** Resolves the verified user or a ready-to-return 401/503 response. */
export async function requireUser(route: string): Promise<{ user: CurrentUser } | { response: NextResponse }> {
  try {
    const user = await getCurrentUser();
    if (!user) return { response: apiError("UNAUTHENTICATED", "Sign in to continue.", 401) };
    return { user };
  } catch (error) {
    return { response: handleUnexpected(error, route) };
  }
}

/**
 * CSRF defence for state-changing requests (in addition to SameSite=Lax cookies):
 * a browser-sent Origin must match APP_ORIGIN exactly. Requests without Origin
 * (non-browser clients) carry no ambient cookies in practice and are allowed.
 */
export function checkOrigin(request: Request, route: string): NextResponse | null {
  const origin = request.headers.get("origin");
  if (origin === null) return null;
  let expected: string;
  try {
    expected = getServerConfig().appOrigin;
  } catch (error) {
    return handleUnexpected(error, route);
  }
  if (origin === expected) return null;
  log("warn", "origin_rejected", { route });
  return apiError("FORBIDDEN", "Cross-origin request rejected.", 403);
}

export const MAX_JSON_BODY_BYTES = 32 * 1024;

/** Reads a JSON body with content-type and size limits. Returns the value or an error response. */
export async function readJsonBody(request: Request, maxBytes = MAX_JSON_BODY_BYTES): Promise<{ value: unknown } | { response: NextResponse }> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(contentType)) {
    return { response: apiError("UNSUPPORTED_MEDIA_TYPE", "Send the request body as application/json.", 415) };
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return { response: tooLarge(maxBytes) };

  const text = await readTextCapped(request, maxBytes);
  if (text === null) return { response: tooLarge(maxBytes) };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { response: apiError("VALIDATION_ERROR", "Request body is not valid JSON.", 400) };
  }
}

const tooLarge = (maxBytes: number) => apiError("PAYLOAD_TOO_LARGE", `Request body must be at most ${maxBytes} bytes.`, 413);

/** Streams the body, aborting once it exceeds maxBytes (content-length can lie or be absent). */
export async function readTextCapped(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
