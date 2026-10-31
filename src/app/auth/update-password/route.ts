import { NextResponse } from "next/server";
import { passwordSchema } from "@/lib/domain/validation";
import { createSupabaseForRequest, getCurrentUser } from "@/lib/server/auth";
import { readForm } from "@/lib/server/auth-forms";
import { getServerConfig } from "@/lib/server/config";
import { checkOrigin, handleUnexpected } from "@/lib/server/http";
import { log } from "@/lib/server/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "POST /auth/update-password";

/** Sets a new password for the signed-in user (after a reset link, or from the account menu). */
export async function POST(request: Request) {
  const rejected = checkOrigin(request, ROUTE);
  if (rejected) return rejected;
  let origin: string;
  try {
    origin = getServerConfig().appOrigin;
  } catch (error) {
    return handleUnexpected(error, ROUTE);
  }
  const back = (error: string) => NextResponse.redirect(`${origin}/reset-password?error=${error}`, 303);
  const fields = await readForm(request);
  const password = fields?.get("password") ?? "";
  if (password !== (fields?.get("confirm") ?? "")) return back("password_mismatch");
  if (!passwordSchema.safeParse(password).success) return back("weak_password");
  try {
    if (!(await getCurrentUser())) return NextResponse.redirect(`${origin}/login?error=link_invalid`, 303);
    const supabase = await createSupabaseForRequest();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      if (error.code === "weak_password") return back("weak_password");
      if (error.code === "same_password") return back("same_password");
      log("warn", "password_update_rejected", { route: ROUTE, errorName: error.name, status: error.status ?? null });
      return back("unavailable");
    }
    return NextResponse.redirect(`${origin}/?password=updated`, 303);
  } catch (error) {
    log("error", "password_update_failed", { route: ROUTE, errorName: error instanceof Error ? error.name : "unknown" });
    return back("unavailable");
  }
}
