import { NextResponse } from "next/server";
import { passwordSignUpSchema } from "@/lib/domain/validation";
import { createSupabaseForRequest } from "@/lib/server/auth";
import { clientIp, ipFailures, readForm, toLogin, withSignInMarker } from "@/lib/server/auth-forms";
import { getServerConfig } from "@/lib/server/config";
import { checkOrigin, handleUnexpected } from "@/lib/server/http";
import { log } from "@/lib/server/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "POST /auth/sign-up";

/**
 * Create an account with email and password (ADR-013, open sign-up).
 * - With "Confirm email" on in Supabase (recommended), no session is returned: the user is asked to
 *   confirm by email, and an address that already has an account gets the same answer (no enumeration).
 * - With it off, the user is signed in straight away.
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
  const email = fields?.get("email")?.trim().toLowerCase();
  const password = fields?.get("password") ?? "";
  if (password !== (fields?.get("confirm") ?? "")) return toLogin(origin, "mode=signup&error=password_mismatch");
  const parsed = passwordSignUpSchema.safeParse({ email, password });
  if (!parsed.success) {
    const weak = parsed.error.issues.some(i => i.path[0] === "password");
    return toLogin(origin, `mode=signup&error=${weak ? "weak_password" : "invalid_email"}`);
  }
  const ip = clientIp(request);
  if (ipFailures.blocked(ip)) return toLogin(origin, "mode=signup&error=rate_limited");

  try {
    const supabase = await createSupabaseForRequest();
    const { data, error } = await supabase.auth.signUp({
      email: parsed.data.email,
      password: parsed.data.password,
      options: { emailRedirectTo: `${origin}/auth/callback` }
    });
    if (error) {
      if (error.status === 429) return toLogin(origin, "mode=signup&error=rate_limited");
      if (error.code === "weak_password") return toLogin(origin, "mode=signup&error=weak_password");
      if (error.code === "user_already_exists" || error.code === "email_exists") {
        // Only reachable with email confirmation off. Point to sign-in without a separate "taken" message.
        return toLogin(origin, "error=account_exists");
      }
      if (error.code === "signup_disabled") return toLogin(origin, "mode=signup&error=signup_disabled");
      log("warn", "sign_up_rejected", { route: ROUTE, errorName: error.name, status: error.status ?? null, code: error.code ?? null });
      return toLogin(origin, `mode=signup&error=${error.status && error.status < 500 ? "invalid_email" : "unavailable"}`);
    }
    if (data.session) return NextResponse.redirect(`${origin}/`, 303);
    return withSignInMarker(toLogin(origin, "sent=confirm"));
  } catch (error) {
    log("error", "sign_up_failed", { route: ROUTE, errorName: error instanceof Error ? error.name : "unknown" });
    return toLogin(origin, "mode=signup&error=unavailable");
  }
}
