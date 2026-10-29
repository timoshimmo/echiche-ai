import { SiteFooter } from "../site-footer";
import { Logo } from "../ui/primitives";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

const MESSAGES: Record<string, string> = {
  invalid_email: "Enter a valid email address.",
  rate_limited: "Too many sign-in emails were requested. Wait a few minutes and try again.",
  link_invalid: "That sign-in link is invalid or has expired. Request a new one.",
  link_other_browser: "Open the sign-in link in the same browser where you requested it, or request a new link here.",
  unavailable: "Sign-in is temporarily unavailable. Try again shortly."
};

const POINTS: [string, string][] = [
  ["Frame the decision", "Give an important question a home, with its context and what is at stake."],
  ["Think it through", "Echiche researches where useful, challenges assumptions and checks its claims before writing a brief."],
  ["Keep what matters", "You approve what it remembers and record the decision, so the reasoning is there when you revisit it."]
];

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const error = typeof params.error === "string" ? MESSAGES[params.error] : undefined;
  const sent = params.sent === "1";

  return (
    <div className="auth">
      <section className="auth-brand on-ink" aria-label="About Echiche">
        <Logo variant="tagline" tone="dark" className="auth-logo" />
        <div className="auth-brand-body">
          <p className="display auth-headline">A thinking partner for decisions that matter.</p>
          <ol className="auth-points">
            {POINTS.map(([title, text], i) => (
              <li key={title}><span className="auth-point-n" aria-hidden="true">0{i + 1}</span><div><strong>{title}</strong><p>{text}</p></div></li>
            ))}
          </ol>
        </div>
        <p className="auth-pilot">Early pilot · invitation only</p>
      </section>

      <section className="auth-panel">
        <div className="auth-form">
          <Logo variant="tagline" className="auth-logo-mobile" />
          <p className="auth-intro-mobile">Echiche helps you work through important decisions and keeps the reasoning behind them.</p>
          <h1>Sign in</h1>
          <p className="muted">We&rsquo;ll email you a one-time sign-in link. No password needed.</p>
          {sent && <div className="notice" role="status"><div className="notice-body">Check your inbox. If that address can sign in, a link is on its way. It expires in 15 minutes and works in this browser.</div></div>}
          {error && <div className="notice notice-error" role="alert"><div className="notice-body">{error}</div></div>}
          <form method="post" action="/auth/sign-in" className="stack">
            <div className="field">
              <label className="field-label" htmlFor="email">Email address</label>
              <input className="input" id="email" type="email" name="email" required maxLength={254} autoComplete="email" placeholder="you@company.com"
                aria-describedby="email-hint" aria-invalid={error === MESSAGES.invalid_email ? true : undefined} />
              <span className="field-hint" id="email-hint">Use the address your invitation was sent to.</span>
            </div>
            <button type="submit" className="btn btn-primary btn-block">Email me a sign-in link <span className="btn-arrow" aria-hidden="true">→</span></button>
          </form>
        </div>
        <SiteFooter />
      </section>
    </div>
  );
}
