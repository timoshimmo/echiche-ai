import { NextResponse } from "next/server";
import { ConfigError } from "./config";
import { log } from "./log";

/** Stable, client-facing error codes (blueprint §6.2). Messages are fixed strings, never raw exception text. */
export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "RUN_FAILED"
  | "CONFIG_INVALID"
  | "STORAGE_UNAVAILABLE"
  | "INTERNAL_ERROR";

export function apiError(code: ApiErrorCode, message: string, status: number): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

export const notFound = (what: "Project" | "Run") => apiError("NOT_FOUND", `${what} not found.`, 404);

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
 * Maps an unexpected error to a safe response and logs it without its message
 * (driver messages can echo user-supplied values).
 */
export function handleUnexpected(error: unknown, route: string): NextResponse {
  const errorName = error instanceof Error ? error.name : typeof error;
  const errorCode = errorCodeOf(error);

  if (error instanceof ConfigError) {
    // ConfigError messages name variables, never values, so they are safe to log.
    log("error", "config_invalid", { route, issues: error.issues });
    return apiError("CONFIG_INVALID", "The server is not configured correctly.", 503);
  }
  if (isStorageUnavailable(error)) {
    log("error", "storage_unavailable", { route, errorName, errorCode });
    return apiError("STORAGE_UNAVAILABLE", "Storage is temporarily unavailable.", 503);
  }
  log("error", "request_failed", { route, errorName, errorCode });
  return apiError("INTERNAL_ERROR", "Something went wrong.", 500);
}

/** Parses a JSON body; returns undefined for missing or malformed JSON. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
