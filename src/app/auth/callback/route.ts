import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { createSupabaseForRequest, SIGN_IN_COOKIE, signInCookieOptions } from "@/lib/server/auth";
import { getServerConfig } from "@/lib/server/config";
import { handleUnexpected } from "@/lib/server/http";
import { log } from "@/lib/server/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "GET /auth/callback";
// Only the flows Echiche uses (magic-link sign-in and first sign-in). Invite, recovery and email
// change are not offered, so their links are refused rather than silently honoured.
const OTP_TYPES = new Set<EmailOtpType>(["email", "magiclink", "signup"]);

function hasSignInMarker(request: Request): boolean {
  const cookies = request.headers.get("cookie") ?? "";
  return cookies.split(/;\s*/).some(pair => pair.startsWith(`${SIGN_IN_COOKIE}=`) && pair.length > SIGN_IN_COOKIE.length + 1);
}

/**
 * Lands the magic link. Supports the PKCE `?code=` flow (default) and the
 * `?token_hash=&type=` flow (custom email templates). Always redirects to a fixed
 * path, never to a URL taken from the query string (no open redirect).
 *
 * The link is honoured only in the browser that asked for it (marker cookie from POST /auth/sign-in):
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

  if (!hasSignInMarker(request)) {
    log("warn", "auth_callback_rejected", { route: ROUTE, reason: "no_sign_in_marker" });
    return NextResponse.redirect(`${origin}/login?error=link_other_browser`, 303);
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
    const response = NextResponse.redirect(`${origin}/`, 303);
    response.cookies.set(SIGN_IN_COOKIE, "", { ...signInCookieOptions(getServerConfig()), maxAge: 0 });
    return response;
  } catch (error) {
    log("error", "auth_callback_failed", { route: ROUTE, errorName: error instanceof Error ? error.name : "unknown" });
    return NextResponse.redirect(`${origin}/login?error=unavailable`, 303);
  }
}
