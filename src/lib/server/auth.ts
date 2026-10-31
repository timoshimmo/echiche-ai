import { createServerClient, type CookieMethodsServer } from "@supabase/ssr";
import { isAuthApiError, isAuthSessionMissingError } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { CurrentUser } from "@/lib/domain/types";
import { getServerConfig, type ServerConfig } from "./config";

/**
 * Supabase Auth integration (ADR-004). All auth traffic is server-side: the browser
 * never holds a Supabase key or calls Supabase directly. Session tokens live in
 * httpOnly, SameSite=Lax cookies managed by @supabase/ssr.
 */
export class AuthUnavailableError extends Error {
  readonly code = "AUTH_UNAVAILABLE";
  constructor() {
    super("Authentication service unavailable");
    this.name = "AuthUnavailableError";
  }
}

export function sessionCookieOptions(config: ServerConfig) {
  return { httpOnly: true, secure: config.secureCookies, sameSite: "lax" as const, path: "/" };
}

/** Marker set by the /auth form routes and required by /auth/callback to sign in (login-CSRF defence, M8 F2). */
export const SIGN_IN_COOKIE = "echiche_signin";
/** Lives as long as a password-reset link (Supabase default: 1 hour); only sent to the callback. */
export function signInCookieOptions(config: ServerConfig) {
  return { httpOnly: true, secure: config.secureCookies, sameSite: "lax" as const, path: "/auth/callback", maxAge: 3600 };
}

/** Supabase client bound to an arbitrary cookie store (used by middleware). */
export function createSupabaseClient(config: ServerConfig, cookieMethods: CookieMethodsServer) {
  return createServerClient(config.supabaseUrl, config.supabasePublishableKey, {
    cookies: cookieMethods,
    cookieOptions: sessionCookieOptions(config),
    auth: { flowType: "pkce" }
  });
}

/** Supabase client bound to the current route handler's request/response cookies. */
export async function createSupabaseForRequest() {
  const config = getServerConfig();
  const store = await cookies();
  return createSupabaseClient(config, {
    getAll: () => store.getAll(),
    setAll: list => {
      for (const { name, value, options } of list) store.set(name, value, options);
    }
  });
}

/**
 * The signed-in user, verified with the Supabase Auth server (getUser), not just by
 * decoding the cookie. Revoked sessions (sign-out) are therefore rejected server-side.
 * Returns null when there is no valid session; throws AuthUnavailableError when the
 * Auth server cannot answer (fail closed: callers respond 503, never "allowed").
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const supabase = await createSupabaseForRequest();
  const { data, error } = await supabase.auth.getUser();
  if (error) {
    if (isAuthSessionMissingError(error)) return null;
    if (isAuthApiError(error) && error.status >= 400 && error.status < 500) return null;
    throw new AuthUnavailableError();
  }
  return data.user ? { id: data.user.id, email: data.user.email ?? null } : null;
}
