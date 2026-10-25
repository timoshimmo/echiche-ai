import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { createSupabaseForRequest } from "@/lib/server/auth";
import { getServerConfig } from "@/lib/server/config";
import { handleUnexpected } from "@/lib/server/http";
import { log } from "@/lib/server/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "GET /auth/callback";
const OTP_TYPES = new Set<EmailOtpType>(["email", "magiclink", "signup", "invite", "recovery", "email_change"]);

/**
 * Lands the magic link. Supports the PKCE `?code=` flow (default) and the
 * `?token_hash=&type=` flow (custom email templates). Always redirects to a fixed
 * path, never to a URL taken from the query string (no open redirect).
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
    return NextResponse.redirect(`${origin}/`, 303);
  } catch (error) {
    log("error", "auth_callback_failed", { route: ROUTE, errorName: error instanceof Error ? error.name : "unknown" });
    return NextResponse.redirect(`${origin}/login?error=unavailable`, 303);
  }
}
