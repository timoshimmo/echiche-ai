import { signInSchema } from "@/lib/domain/validation";
import { createSupabaseForRequest } from "@/lib/server/auth";
import { readForm, toLogin, withSignInMarker } from "@/lib/server/auth-forms";
import { getServerConfig } from "@/lib/server/config";
import { checkOrigin, handleUnexpected } from "@/lib/server/http";
import { log } from "@/lib/server/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "POST /auth/forgot-password";

/**
 * Emails a password-reset link (ADR-013: the only email sign-in still sends). The answer is the same
 * whether or not the address has an account. The link lands at /auth/callback?flow=recovery, which then
 * opens /reset-password.
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
  const fields = await readForm(request, 2048);
  const parsed = signInSchema.safeParse({ email: fields?.get("email")?.trim().toLowerCase() });
  if (!parsed.success) return toLogin(origin, "mode=forgot&error=invalid_email");
  try {
    const supabase = await createSupabaseForRequest();
    const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, { redirectTo: `${origin}/auth/callback?flow=recovery` });
    if (error) {
      if (error.status === 429) return toLogin(origin, "mode=forgot&error=rate_limited");
      log("warn", "password_reset_rejected", { route: ROUTE, errorName: error.name, status: error.status ?? null });
      if (!error.status || error.status >= 500) return toLogin(origin, "mode=forgot&error=unavailable");
    }
    return withSignInMarker(toLogin(origin, "sent=reset"));
  } catch (error) {
    log("error", "password_reset_failed", { route: ROUTE, errorName: error instanceof Error ? error.name : "unknown" });
    return toLogin(origin, "mode=forgot&error=unavailable");
  }
}
