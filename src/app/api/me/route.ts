import { ok, requireUser } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The signed-in user's id and email (their own data only). */
export async function GET() {
  const auth = await requireUser("GET /api/me");
  if ("response" in auth) return auth.response;
  return ok(auth.user);
}
