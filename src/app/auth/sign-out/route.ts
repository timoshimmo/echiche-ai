import { NextResponse } from "next/server";
import { createSupabaseForRequest } from "@/lib/server/auth";
import { getServerConfig } from "@/lib/server/config";
import { checkOrigin, handleUnexpected } from "@/lib/server/http";
import { log } from "@/lib/server/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "POST /auth/sign-out";

/**
 * Revokes the session's refresh tokens on the Auth server and clears the cookies.
 * Because every request verifies the session with getUser(), a signed-out session
 * is rejected immediately, not just when its access token expires.
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
    const { error } = await supabase.auth.signOut({ scope: "local" });
    if (error) log("warn", "sign_out_error", { route: ROUTE, errorName: error.name });
  } catch (error) {
    log("error", "sign_out_failed", { route: ROUTE, errorName: error instanceof Error ? error.name : "unknown" });
  }
  return NextResponse.redirect(`${origin}/login`, 303);
}
