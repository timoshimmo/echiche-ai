import { passwordSignInSchema } from "@/lib/domain/validation";
import { createSupabaseForRequest } from "@/lib/server/auth";
import { clientIp, emailFailures, ipFailures, readForm, toLogin } from "@/lib/server/auth-forms";
import { getServerConfig } from "@/lib/server/config";
import { checkOrigin, handleUnexpected } from "@/lib/server/http";
import { log } from "@/lib/server/log";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "POST /auth/sign-in";

/**
 * Email and password sign-in from the /login form (ADR-013). Wrong email and wrong password get the same
 * answer, so the form cannot be used to find out who has an account. Repeated failures are limited per
 * email and per client IP before Supabase is even asked.
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

  const fields = await readForm(request);
  const parsed = passwordSignInSchema.safeParse({ email: fields?.get("email")?.trim().toLowerCase(), password: fields?.get("password") ?? "" });
  if (!parsed.success) return toLogin(origin, "error=invalid_credentials");
  const { email, password } = parsed.data;
  const ip = clientIp(request);
  if (emailFailures.blocked(email) || ipFailures.blocked(ip)) {
    log("warn", "sign_in_throttled", { route: ROUTE });
    return toLogin(origin, "error=rate_limited");
  }

  try {
    const supabase = await createSupabaseForRequest();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      if (error.status === 429) return toLogin(origin, "error=rate_limited");
      if (error.code === "email_not_confirmed") return toLogin(origin, "error=email_not_confirmed");
      if (error.status && error.status < 500) {
        emailFailures.fail(email);
        ipFailures.fail(ip);
        return toLogin(origin, "error=invalid_credentials");
      }
      log("warn", "sign_in_rejected", { route: ROUTE, errorName: error.name, status: error.status ?? null });
      return toLogin(origin, "error=unavailable");
    }
    emailFailures.clear(email);
    return NextResponse.redirect(`${origin}/`, 303);
  } catch (error) {
    log("error", "sign_in_failed", { route: ROUTE, errorName: error instanceof Error ? error.name : "unknown" });
    return toLogin(origin, "error=unavailable");
  }
}
