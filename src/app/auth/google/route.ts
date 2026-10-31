import { NextResponse } from "next/server";
import { createSupabaseForRequest } from "@/lib/server/auth";
import { toLogin, withSignInMarker } from "@/lib/server/auth-forms";
import { getServerConfig } from "@/lib/server/config";
import { checkOrigin, handleUnexpected } from "@/lib/server/http";
import { log } from "@/lib/server/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "POST /auth/google";

/**
 * "Continue with Google" (ADR-013). Starts the OAuth flow server-side with PKCE: Supabase returns Google's
 * consent URL and @supabase/ssr stores the code verifier in a cookie, so only this browser can finish the
 * sign-in at /auth/callback. A POST (not a link) keeps another site from starting it for the user.
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
  try {
    const supabase = await createSupabaseForRequest();
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${origin}/auth/callback`, skipBrowserRedirect: true, queryParams: { prompt: "select_account" } }
    });
    if (error || !data.url || !data.url.startsWith("https://")) {
      log("warn", "google_sign_in_unavailable", { route: ROUTE, errorName: error?.name ?? "no_url", status: error?.status ?? null });
      return toLogin(origin, "error=google_unavailable");
    }
    return withSignInMarker(NextResponse.redirect(data.url, 303));
  } catch (error) {
    log("error", "google_sign_in_failed", { route: ROUTE, errorName: error instanceof Error ? error.name : "unknown" });
    return toLogin(origin, "error=google_unavailable");
  }
}
