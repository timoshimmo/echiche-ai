import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { createSupabaseForRequest, SIGN_IN_COOKIE, signInCookieOptions } from "@/lib/server/auth";
import { getServerConfig } from "@/lib/server/config";
import { handleUnexpected } from "@/lib/server/http";
import { log } from "@/lib/server/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "GET /auth/callback";
// Only the flows Echiche uses (ADR-013): email confirmation after sign-up, password recovery, and the
// Google OAuth code. Invite, magic link and email change are not offered, so their links are refused.
const OTP_TYPES = new Set<EmailOtpType>(["signup", "email", "recovery"]);

function hasSignInMarker(request: Request): boolean {
  const cookies = request.headers.get("cookie") ?? "";
  return cookies.split(/;\s*/).some(pair => pair.startsWith(`${SIGN_IN_COOKIE}=`) && pair.length > SIGN_IN_COOKIE.length + 1);
}

/**
 * Lands Google sign-in, sign-up confirmation and password-reset links. Supports the PKCE `?code=` flow (default) and the
 * `?token_hash=&type=` flow (custom email templates). Always redirects to a fixed
 * path, never to a URL taken from the query string (no open redirect).
 *
 * The link is honoured only in the browser that asked for it (marker cookie from the /auth form routes):
 * otherwise an attacker could request a link for their own account and send it to a victim, who would
 * then be signed in as the attacker and might type confidential plans into the attacker's account.
 */
export async function GET(request: Request) {
  let origin: string;
  try {
    origin = getServerConfig().appOrigin;
  } catch (error) {
    return handleUnexpected(error, ROUTE);
  }
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  const tokenHash = params.get("token_hash");
  const type = params.get("type") as EmailOtpType | null;
  // A fixed choice of next page, never a URL from the query string (no open redirect).
  const recovery = params.get("flow") === "recovery" || type === "recovery";

  if (!code && !tokenHash && params.get("error")) {
    // Google (or Supabase) sent the user back with an error, e.g. they cancelled the consent screen.
    log("info", "auth_callback_provider_error", { route: ROUTE });
    return NextResponse.redirect(`${origin}/login?error=google_cancelled`, 303);
  }

  if (!hasSignInMarker(request)) {
    log("warn", "auth_callback_rejected", { route: ROUTE, reason: "no_sign_in_marker" });
    // A confirmation link opened elsewhere (say, on a phone) has already confirmed the address at Supabase
    // by the time it gets here; only the sign-in is refused. Say so, and let the user sign in with a password.
    return NextResponse.redirect(`${origin}/login?${recovery ? "error=link_other_browser" : "sent=confirmed"}`, 303);
  }

  try {
    const supabase = await createSupabaseForRequest();
    let failed = true;
    if (code) {
      failed = Boolean((await supabase.auth.exchangeCodeForSession(code)).error);
    } else if (tokenHash && type && OTP_TYPES.has(type)) {
      failed = Boolean((await supabase.auth.verifyOtp({ token_hash: tokenHash, type })).error);
    }
    if (failed) {
      log("warn", "auth_callback_rejected", { route: ROUTE });
      return NextResponse.redirect(`${origin}/login?error=link_invalid`, 303);
    }
    const response = NextResponse.redirect(`${origin}${recovery ? "/reset-password" : "/"}`, 303);
    response.cookies.set(SIGN_IN_COOKIE, "", { ...signInCookieOptions(getServerConfig()), maxAge: 0 });
    return response;
  } catch (error) {
    log("error", "auth_callback_failed", { route: ROUTE, errorName: error instanceof Error ? error.name : "unknown" });
    return NextResponse.redirect(`${origin}/login?error=unavailable`, 303);
  }
}
