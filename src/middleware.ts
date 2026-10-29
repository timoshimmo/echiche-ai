import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseClient } from "@/lib/server/auth";
import { getServerConfig } from "@/lib/server/config";

/**
 * Page protection + session refresh for app pages. API routes and /auth/* are excluded:
 * they authenticate themselves (requireUser) and return JSON 401s instead of redirects.
 * Runs on the Node.js runtime (stable in Next 15.5) so it reads the same validated config.
 */
export async function middleware(request: NextRequest) {
  let serverConfig;
  try {
    serverConfig = getServerConfig();
  } catch {
    return new NextResponse("Server is not configured correctly.", { status: 503 });
  }

  let response = NextResponse.next({ request });
  const supabase = createSupabaseClient(serverConfig, {
    getAll: () => request.cookies.getAll(),
    setAll: list => {
      for (const { name, value } of list) request.cookies.set(name, value);
      response = NextResponse.next({ request });
      for (const { name, value, options } of list) response.cookies.set(name, value, options);
    }
  });

  let signedIn = false;
  try {
    const { data } = await supabase.auth.getUser();
    signedIn = Boolean(data.user);
  } catch {
    signedIn = false; // fail closed: treat an unreachable Auth server as signed out
  }
  if (signedIn) return response;

  const redirect = NextResponse.redirect(new URL("/login", serverConfig.appOrigin), 303);
  for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
  return redirect;
}

export const config = {
  runtime: "nodejs",
  // Public: API (own auth), auth callbacks, sign-in, legal pages, build output and brand assets (the
  // sign-in page shows the logo before anyone is signed in; these files are public brand material).
  matcher: ["/((?!api/|auth/|login|privacy|terms|_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|brand/).*)"]
};
