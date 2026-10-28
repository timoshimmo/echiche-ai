import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetServerConfigForTests } from "@/lib/server/config";

// Only the Supabase client is faked; the route logic, cookies and redirects are real.
const supabase = vi.hoisted(() => ({
  signInWithOtp: vi.fn(async () => ({ error: null as null | { status?: number; name: string } })),
  exchangeCodeForSession: vi.fn(async () => ({ error: null })),
  verifyOtp: vi.fn(async () => ({ error: null }))
}));
vi.mock("@/lib/server/auth", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/server/auth")>()),
  createSupabaseForRequest: async () => ({ auth: supabase })
}));

const { POST: signIn } = await import("./sign-in/route");
const { GET: callback } = await import("./callback/route");
const ORIGIN = "http://localhost:3000";

const form = (email: string, headers: Record<string, string> = {}) => new Request(`${ORIGIN}/auth/sign-in`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, ...headers },
  body: new URLSearchParams({ email }).toString()
});
const land = (query: string, cookie?: string) =>
  new Request(`${ORIGIN}/auth/callback?${query}`, { headers: cookie ? { cookie } : {} });

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DATABASE_URL", "postgresql://echiche_web:placeholder@localhost:5432/unused");
  vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_placeholder_placeholder");
  vi.stubEnv("APP_ORIGIN", ORIGIN);
  resetServerConfigForTests();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const fn of Object.values(supabase)) fn.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("magic-link sign-in is bound to the browser that asked (M8 F2: login CSRF)", () => {
  it("sign-in sets a short-lived, httpOnly marker scoped to the callback", async () => {
    const response = await signIn(form("alice@example.test"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/login?sent=1`);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^echiche_signin=[A-Za-z0-9_-]{43};/);
    expect(cookie).toMatch(/Path=\/auth\/callback/);
    expect(cookie).toMatch(/Max-Age=900/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=lax/i);
  });

  it("refuses a link opened in a browser that did not request it, without redeeming it", async () => {
    // The attack: request a link for the attacker's own account, send it to the victim.
    for (const query of ["token_hash=attacker-hash&type=magiclink", "code=attacker-code"]) {
      const response = await callback(land(query));
      expect(response.headers.get("location")).toBe(`${ORIGIN}/login?error=link_other_browser`);
    }
    expect(supabase.verifyOtp).not.toHaveBeenCalled();
    expect(supabase.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("honours the link in the requesting browser and clears the marker", async () => {
    const response = await callback(land("token_hash=h&type=magiclink", "echiche_signin=abc123; other=1"));
    expect(supabase.verifyOtp).toHaveBeenCalledWith({ token_hash: "h", type: "magiclink" });
    expect(response.headers.get("location")).toBe(`${ORIGIN}/`);
    expect(response.headers.get("set-cookie")).toMatch(/echiche_signin=;.*Max-Age=0/);
  });

  it("refuses link types Echiche does not offer (invite, recovery, email change)", async () => {
    for (const type of ["invite", "recovery", "email_change"]) {
      const response = await callback(land(`token_hash=h&type=${type}`, "echiche_signin=abc123"));
      expect(response.headers.get("location")).toBe(`${ORIGIN}/login?error=link_invalid`);
    }
    expect(supabase.verifyOtp).not.toHaveBeenCalled();
  });

  it("rejects cross-origin sign-in posts and never redirects to a URL from the query", async () => {
    expect((await signIn(form("a@example.test", { origin: "https://evil.example" }))).status).toBe(403);
    const response = await callback(land("code=c&next=https://evil.example", "echiche_signin=x"));
    expect(response.headers.get("location")).toBe(`${ORIGIN}/`);
  });

  it("does not reveal whether an account exists", async () => {
    supabase.signInWithOtp.mockResolvedValueOnce({ error: { status: 422, name: "AuthApiError" } });
    const unknown = await signIn(form("nobody@example.test"));
    const known = await signIn(form("alice@example.test"));
    expect(unknown.headers.get("location")).toBe(known.headers.get("location"));
  });
});
