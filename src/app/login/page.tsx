import Link from "next/link";
import { SiteFooter } from "../site-footer";
import { PasswordInput } from "../ui/password-input";
import { Logo } from "../ui/primitives";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

const MESSAGES: Record<string, string> = {
  invalid_email: "Enter a valid email address.",
  invalid_credentials: "That email and password don't match an account. Check them and try again.",
  email_not_confirmed: "Confirm your email address first: open the link we sent when you created your account.",
  weak_password: "Use a password of at least 12 characters (at most 72 bytes).",
  password_mismatch: "The two passwords don't match.",
  account_exists: "There's already an account for that email. Sign in, or reset your password.",
  signup_disabled: "New accounts are not being created right now.",
  rate_limited: "Too many attempts. Wait a few minutes and try again.",
  google_unavailable: "Google sign-in isn't available right now. Use your email and password, or try again later.",
  google_cancelled: "Google sign-in was cancelled or didn't complete. Try again.",
  link_invalid: "That link is invalid or has expired. Request a new one.",
  link_other_browser: "Open the link in the same browser where you requested it, or request a new one here.",
  unavailable: "Sign-in is temporarily unavailable. Try again shortly."
};
const SENT: Record<string, string> = {
  confirm: "Check your inbox to confirm your email address, then sign in. The link works in this browser.",
  reset: "If that address has an account, a password-reset link is on its way. Open it in this browser within an hour.",
  confirmed: "If that link was valid, your email address is confirmed. Sign in with your email and password."
};

const POINTS: [string, string][] = [
  ["Frame the decision", "Give an important question a home, with its context and what is at stake."],
  ["Think it through", "Echiche researches where useful, challenges assumptions and checks its claims before writing a brief."],
  ["Keep what matters", "You approve what it remembers and record the decision, so the reasoning is there when you revisit it."]
];

type Mode = "signin" | "signup" | "forgot";

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const mode: Mode = params.mode === "signup" ? "signup" : params.mode === "forgot" ? "forgot" : "signin";
  const errorKey = typeof params.error === "string" ? params.error : undefined;
  const error = errorKey ? MESSAGES[errorKey] : undefined;
  const sent = typeof params.sent === "string" ? SENT[params.sent] : undefined;
  const title = mode === "signup" ? "Create your account" : mode === "forgot" ? "Reset your password" : "Sign in";

  return (
    <div className="auth">
      <section className="auth-brand on-ink" aria-label="About Echiche">
        <Logo variant="tagline" tone="dark" className="auth-logo" />
        <div className="auth-brand-body">
          <p className="display auth-headline">A thinking partner for decisions that matter.</p>
          <ol className="auth-points">
            {POINTS.map(([t, text], i) => (
              <li key={t}><span className="auth-point-n" aria-hidden="true">0{i + 1}</span><div><strong>{t}</strong><p>{text}</p></div></li>
            ))}
          </ol>
        </div>
        <p className="auth-pilot">Early pilot</p>
      </section>

      <section className="auth-panel">
        <div className="auth-form">
          <Logo variant="tagline" className="auth-logo-mobile" />
          <p className="auth-intro-mobile">Echiche helps you work through important decisions and keeps the reasoning behind them.</p>
          <h1>{title}</h1>
          {sent && <div className="notice" role="status"><div className="notice-body">{sent}</div></div>}
          {error && <div className="notice notice-error" role="alert"><div className="notice-body">{error}</div></div>}

          {mode !== "forgot" && <>
            <form method="post" action="/auth/google">
              <button type="submit" className="btn btn-secondary btn-block google-button">
                <GoogleMark /> Continue with Google
              </button>
            </form>
            <div className="auth-divider" role="separator"><span>or with email</span></div>
          </>}

          {mode === "signin" && (
            <form method="post" action="/auth/sign-in" className="stack">
              <div className="field">
                <label className="field-label" htmlFor="email">Email address</label>
                <input className="input" id="email" type="email" name="email" required maxLength={254} autoComplete="email" placeholder="you@company.com"
                  aria-invalid={errorKey === "invalid_credentials" || undefined} />
              </div>
              <div className="field">
                <div className="field-label-row">
                  <label className="field-label" htmlFor="password">Password</label>
                  <Link href="/login?mode=forgot" className="small">Forgot password?</Link>
                </div>
                <PasswordInput id="password" name="password" autoComplete="current-password" invalid={errorKey === "invalid_credentials"} />
              </div>
              <button type="submit" className="btn btn-primary btn-block">Sign in <span className="btn-arrow" aria-hidden="true">→</span></button>
              <p className="muted small auth-switch">New to Echiche? <Link href="/login?mode=signup">Create an account</Link></p>
            </form>
          )}

          {mode === "signup" && (
            <form method="post" action="/auth/sign-up" className="stack">
              <div className="field">
                <label className="field-label" htmlFor="email">Email address</label>
                <input className="input" id="email" type="email" name="email" required maxLength={254} autoComplete="email" placeholder="you@company.com"
                  aria-invalid={errorKey === "invalid_email" || undefined} />
              </div>
              <div className="field">
                <label className="field-label" htmlFor="password">Password</label>
                <PasswordInput id="password" name="password" autoComplete="new-password" minLength={12} describedBy="password-hint" invalid={errorKey === "weak_password"} />
                <span className="field-hint" id="password-hint">At least 12 characters. A short sentence is easy to remember and hard to guess.</span>
              </div>
              <div className="field">
                <label className="field-label" htmlFor="confirm">Confirm password</label>
                <PasswordInput id="confirm" name="confirm" autoComplete="new-password" minLength={12} invalid={errorKey === "password_mismatch"} />
              </div>
              <button type="submit" className="btn btn-primary btn-block">Create account <span className="btn-arrow" aria-hidden="true">→</span></button>
              <p className="muted small">By creating an account you agree to the <Link href="/terms">terms</Link> and <Link href="/privacy">privacy notice</Link>.</p>
              <p className="muted small auth-switch">Already have an account? <Link href="/login">Sign in</Link></p>
            </form>
          )}

          {mode === "forgot" && (
            <form method="post" action="/auth/forgot-password" className="stack">
              <p className="muted">Enter your account&rsquo;s email address and we&rsquo;ll send you a link to choose a new password.</p>
              <div className="field">
                <label className="field-label" htmlFor="email">Email address</label>
                <input className="input" id="email" type="email" name="email" required maxLength={254} autoComplete="email" placeholder="you@company.com" />
              </div>
              <button type="submit" className="btn btn-primary btn-block">Email me a reset link</button>
              <p className="muted small auth-switch"><Link href="/login">Back to sign in</Link></p>
            </form>
          )}
        </div>
        <SiteFooter />
      </section>
    </div>
  );
}

/** Google's "G" mark (brand guidelines: shown unaltered on a sign-in button). Decorative; the label names it. */
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
