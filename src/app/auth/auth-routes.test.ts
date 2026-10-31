import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetServerConfigForTests } from "@/lib/server/config";

type AuthError = null | { status?: number; name: string; code?: string };

// Only the Supabase client is faked; the route logic, cookies, limits and redirects are real.
const supabase = vi.hoisted(() => ({
  signInWithPassword: vi.fn(async () => ({ error: null as AuthError })),
  signUp: vi.fn(async () => ({ data: { session: null as object | null }, error: null as AuthError })),
  signInWithOAuth: vi.fn(async () => ({ data: { url: "https://accounts.google.com/o/oauth2/v2/auth?x=1" as string | null }, error: null as AuthError })),
  resetPasswordForEmail: vi.fn(async () => ({ error: null as AuthError })),
  updateUser: vi.fn(async () => ({ error: null as AuthError })),
  exchangeCodeForSession: vi.fn(async () => ({ error: null })),
  verifyOtp: vi.fn(async () => ({ error: null }))
}));
const session = vi.hoisted(() => ({ user: { id: "u1", email: "alice@example.test" } as null | { id: string; email: string } }));
vi.mock("@/lib/server/auth", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/server/auth")>()),
  createSupabaseForRequest: async () => ({ auth: supabase }),
  getCurrentUser: async () => session.user
}));

const { POST: signIn } = await import("./sign-in/route");
const { POST: signUp } = await import("./sign-up/route");
const { POST: google } = await import("./google/route");
const { POST: forgot } = await import("./forgot-password/route");
const { POST: updatePassword } = await import("./update-password/route");
const { GET: callback } = await import("./callback/route");
const { emailFailures, ipFailures } = await import("@/lib/server/auth-forms");
const ORIGIN = "http://localhost:3000";
const STRONG = "correct horse battery";

let ip = 0;
const post = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) => new Request(`${ORIGIN}${path}`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "x-forwarded-for": `198.51.100.${ip}`, ...headers },
  body: new URLSearchParams(fields).toString()
});
const land = (query: string, cookie?: string) =>
  new Request(`${ORIGIN}/auth/callback?${query}`, { headers: cookie ? { cookie } : {} });
const where = (response: Response) => response.headers.get("location");

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
  session.user = { id: "u1", email: "alice@example.test" };
  ip += 1; // a fresh client IP per test, so the failure limiter starts empty
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("password sign-in (ADR-013)", () => {
  it("signs in with email and password and goes to the overview", async () => {
    const response = await signIn(post("/auth/sign-in", { email: " Alice@Example.test ", password: STRONG }));
    expect(supabase.signInWithPassword).toHaveBeenCalledWith({ email: "alice@example.test", password: STRONG });
    expect(response.status).toBe(303);
    expect(where(response)).toBe(`${ORIGIN}/`);
  });

  it("gives the same answer for an unknown email and a wrong password (no account enumeration)", async () => {
    supabase.signInWithPassword.mockResolvedValue({ error: { status: 400, name: "AuthApiError", code: "invalid_credentials" } });
    const unknown = await signIn(post("/auth/sign-in", { email: "nobody@example.test", password: "x" }));
    const wrong = await signIn(post("/auth/sign-in", { email: "alice@example.test", password: "y" }));
    expect(where(unknown)).toBe(`${ORIGIN}/login?error=invalid_credentials`);
    expect(where(wrong)).toBe(where(unknown));
    supabase.signInWithPassword.mockReset();
    supabase.signInWithPassword.mockResolvedValue({ error: null });
  });

  it("stops repeated failures for one email before asking Supabase again", async () => {
    supabase.signInWithPassword.mockResolvedValue({ error: { status: 400, name: "AuthApiError", code: "invalid_credentials" } });
    const email = `target${ip}@example.test`;
    for (let i = 0; i < 10; i++) {
      await signIn(post("/auth/sign-in", { email, password: `guess-${i}` }, { "x-forwarded-for": `203.0.113.${i}` }));
    }
    supabase.signInWithPassword.mockClear();
    const blocked = await signIn(post("/auth/sign-in", { email, password: "guess-final" }, { "x-forwarded-for": "203.0.113.200" }));
    expect(where(blocked)).toBe(`${ORIGIN}/login?error=rate_limited`);
    expect(supabase.signInWithPassword).not.toHaveBeenCalled();
    emailFailures.clear(email);
    supabase.signInWithPassword.mockReset();
    supabase.signInWithPassword.mockResolvedValue({ error: null });
  });

  it("explains an unconfirmed email and maps outages to a retry message", async () => {
    supabase.signInWithPassword.mockResolvedValueOnce({ error: { status: 400, name: "AuthApiError", code: "email_not_confirmed" } });
    expect(where(await signIn(post("/auth/sign-in", { email: "a@example.test", password: STRONG })))).toBe(`${ORIGIN}/login?error=email_not_confirmed`);
    supabase.signInWithPassword.mockResolvedValueOnce({ error: { status: 503, name: "AuthRetryableFetchError" } });
    expect(where(await signIn(post("/auth/sign-in", { email: "a@example.test", password: STRONG })))).toBe(`${ORIGIN}/login?error=unavailable`);
  });

  it("rejects cross-origin posts (login CSRF)", async () => {
    expect((await signIn(post("/auth/sign-in", { email: "a@example.test", password: STRONG }, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await signUp(post("/auth/sign-up", { email: "a@example.test", password: STRONG, confirm: STRONG }, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await google(post("/auth/google", {}, { origin: "https://evil.example" }))).status).toBe(403);
    expect(supabase.signInWithPassword).not.toHaveBeenCalled();
  });
});

describe("sign-up (open, ADR-013)", () => {
  it("asks for email confirmation when Supabase returns no session, and marks this browser", async () => {
    const response = await signUp(post("/auth/sign-up", { email: "new@example.test", password: STRONG, confirm: STRONG }));
    expect(supabase.signUp).toHaveBeenCalledWith({ email: "new@example.test", password: STRONG, options: { emailRedirectTo: `${ORIGIN}/auth/callback` } });
    expect(where(response)).toBe(`${ORIGIN}/login?sent=confirm`);
    expect(response.headers.get("set-cookie")).toMatch(/^echiche_signin=[A-Za-z0-9_-]{43};.*Path=\/auth\/callback/);
  });

  it("signs straight in when confirmation is off", async () => {
    supabase.signUp.mockResolvedValueOnce({ data: { session: {} }, error: null });
    expect(where(await signUp(post("/auth/sign-up", { email: "new@example.test", password: STRONG, confirm: STRONG })))).toBe(`${ORIGIN}/`);
  });

  it("refuses short or mismatched passwords before calling Supabase", async () => {
    expect(where(await signUp(post("/auth/sign-up", { email: "n@example.test", password: "short", confirm: "short" })))).toBe(`${ORIGIN}/login?mode=signup&error=weak_password`);
    expect(where(await signUp(post("/auth/sign-up", { email: "n@example.test", password: STRONG, confirm: "different one!!" })))).toBe(`${ORIGIN}/login?mode=signup&error=password_mismatch`);
    expect(where(await signUp(post("/auth/sign-up", { email: "n@example.test", password: "é".repeat(37), confirm: "é".repeat(37) })))).toBe(`${ORIGIN}/login?mode=signup&error=weak_password`);
    expect(supabase.signUp).not.toHaveBeenCalled();
  });
});

describe("Google sign-in (ADR-013)", () => {
  it("starts OAuth server-side with the callback as the only return address", async () => {
    const response = await google(post("/auth/google", {}));
    expect(supabase.signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: { redirectTo: `${ORIGIN}/auth/callback`, skipBrowserRedirect: true, queryParams: { prompt: "select_account" } }
    });
    expect(where(response)).toBe("https://accounts.google.com/o/oauth2/v2/auth?x=1");
    expect(response.headers.get("set-cookie")).toMatch(/^echiche_signin=/);
  });

  it("falls back to a clear message when Google is not configured or the user cancels", async () => {
    supabase.signInWithOAuth.mockResolvedValueOnce({ data: { url: null }, error: { status: 400, name: "AuthApiError", code: "validation_failed" } });
    expect(where(await google(post("/auth/google", {})))).toBe(`${ORIGIN}/login?error=google_unavailable`);
    expect(where(await callback(land("error=access_denied&error_description=cancelled", "echiche_signin=x")))).toBe(`${ORIGIN}/login?error=google_cancelled`);
  });
});

describe("callback: bound to the browser that started the flow (M8 F2)", () => {
  it("completes sign-in only with the marker, then clears it", async () => {
    const response = await callback(land("code=c", "echiche_signin=abc123; other=1"));
    expect(supabase.exchangeCodeForSession).toHaveBeenCalledWith("c");
    expect(where(response)).toBe(`${ORIGIN}/`);
    expect(response.headers.get("set-cookie")).toMatch(/echiche_signin=;.*Max-Age=0/);
  });

  it("does not sign in from another browser; a confirmation link opened elsewhere asks for a password sign-in", async () => {
    expect(where(await callback(land("code=attacker-code")))).toBe(`${ORIGIN}/login?sent=confirmed`);
    expect(where(await callback(land("code=c&flow=recovery")))).toBe(`${ORIGIN}/login?error=link_other_browser`);
    expect(supabase.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("sends a password-reset link to the new-password page, never to a URL from the query", async () => {
    expect(where(await callback(land("code=c&flow=recovery&next=https://evil.example", "echiche_signin=x")))).toBe(`${ORIGIN}/reset-password`);
    expect(where(await callback(land("token_hash=h&type=recovery", "echiche_signin=x")))).toBe(`${ORIGIN}/reset-password`);
    expect(where(await callback(land("code=c&next=https://evil.example", "echiche_signin=x")))).toBe(`${ORIGIN}/`);
  });

  it("refuses link types Echiche does not offer (invite, magic link, email change)", async () => {
    for (const type of ["invite", "magiclink", "email_change"]) {
      expect(where(await callback(land(`token_hash=h&type=${type}`, "echiche_signin=abc123")))).toBe(`${ORIGIN}/login?error=link_invalid`);
    }
    expect(supabase.verifyOtp).not.toHaveBeenCalled();
  });
});

describe("forgotten and new passwords", () => {
  it("answers the same whether or not the address has an account", async () => {
    const known = await forgot(post("/auth/forgot-password", { email: "alice@example.test" }));
    supabase.resetPasswordForEmail.mockResolvedValueOnce({ error: { status: 400, name: "AuthApiError" } });
    const unknown = await forgot(post("/auth/forgot-password", { email: "nobody@example.test" }));
    expect(where(known)).toBe(`${ORIGIN}/login?sent=reset`);
    expect(where(unknown)).toBe(where(known));
    expect(supabase.resetPasswordForEmail).toHaveBeenCalledWith("alice@example.test", { redirectTo: `${ORIGIN}/auth/callback?flow=recovery` });
  });

  it("updates the password only for a signed-in user, with the same rules as sign-up", async () => {
    expect(where(await updatePassword(post("/auth/update-password", { password: STRONG, confirm: STRONG })))).toBe(`${ORIGIN}/?password=updated`);
    expect(supabase.updateUser).toHaveBeenCalledWith({ password: STRONG });
    expect(where(await updatePassword(post("/auth/update-password", { password: "short", confirm: "short" })))).toBe(`${ORIGIN}/reset-password?error=weak_password`);
    session.user = null;
    expect(where(await updatePassword(post("/auth/update-password", { password: STRONG, confirm: STRONG })))).toBe(`${ORIGIN}/login?error=link_invalid`);
    expect((await updatePassword(post("/auth/update-password", { password: STRONG, confirm: STRONG }, { origin: "https://evil.example" }))).status).toBe(403);
    ipFailures.clear("unused");
  });
});
