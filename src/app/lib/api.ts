// Browser-side client for the app's own JSON API ({ data } / { error: { code, message } }).
// One place for: no caching, JSON bodies, session expiry (401 → sign-in) and the API's own error text.

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) { super(message); }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<T> {
  const hasBody = init?.body !== undefined;
  let response: Response;
  try {
    response = await fetch(path, {
      method: init?.method ?? "GET",
      cache: "no-store",
      headers: { ...(hasBody ? { "content-type": "application/json" } : {}), ...init?.headers },
      body: hasBody ? JSON.stringify(init!.body) : undefined
    });
  } catch {
    throw new ApiError("Echiche couldn't be reached. Check your connection and try again.", 0, "NETWORK");
  }
  if (response.status === 401) {
    window.location.assign("/login");
    throw new ApiError("Your session has ended. Please sign in again.", 401, "UNAUTHENTICATED");
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(body?.error?.message ?? "That didn't work. Please try again.", response.status, body?.error?.code ?? null);
  }
  return body?.data as T;
}

export const errorMessage = (e: unknown, fallback = "Something went wrong. Please try again.") =>
  e instanceof Error && e.message ? e.message : fallback;
