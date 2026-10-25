import { NextResponse } from "next/server";
import { signInSchema } from "@/lib/domain/validation";
import { createSupabaseForRequest } from "@/lib/server/auth";
import { getServerConfig } from "@/lib/server/config";
import { checkOrigin, handleUnexpected, readTextCapped } from "@/lib/server/http";
import { log } from "@/lib/server/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "POST /auth/sign-in";

const toLogin = (origin: string, query: string) => NextResponse.redirect(`${origin}/login?${query}`, 303);

/**
 * Magic-link sign-in from the /login form (application/x-www-form-urlencoded).
 * Always answers "check your email" for a well-formed address, whether or not an
 * account exists, so the endpoint cannot be used to enumerate users.
 * Per-address and per-IP sending limits are enforced by Supabase Auth (config.toml
 * [auth.rate_limit] locally; dashboard settings in hosted projects).
 */
export async function POST(request: Request) {
  const rejected = checkOrigin(request, ROUTE);
  if (rejected) return rejected;
  let origin: string;
  try {
    origin = getServerConfig().appOrigin;
  } catch (error) {
    return handleUnexpected(error, ROUTE);
  }

  const text = await readTextCapped(request, 2048);
  const email = text === null ? undefined : new URLSearchParams(text).get("email")?.trim();
  const parsed = signInSchema.safeParse({ email });
  if (!parsed.success) return toLogin(origin, "error=invalid_email");

  try {
    const supabase = await createSupabaseForRequest();
    const { error } = await supabase.auth.signInWithOtp({
      email: parsed.data.email,
      options: { emailRedirectTo: `${origin}/auth/callback` }
    });
    if (error) {
      if (error.status === 429) return toLogin(origin, "error=rate_limited");
      // Includes "signups not allowed" for unknown addresses when sign-up is disabled: do not reveal it.
      log("warn", "sign_in_otp_rejected", { route: ROUTE, errorName: error.name, status: error.status ?? null });
      if (error.status && error.status < 500) return toLogin(origin, "sent=1");
      return toLogin(origin, "error=unavailable");
    }
    return toLogin(origin, "sent=1");
  } catch (error) {
    log("error", "sign_in_failed", { route: ROUTE, errorName: error instanceof Error ? error.name : "unknown" });
    return toLogin(origin, "error=unavailable");
  }
}
