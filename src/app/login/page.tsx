import { Logo } from "../ui/primitives";
import { SiteFooter } from "../site-footer";

export const dynamic = "force-dynamic";

const MESSAGES: Record<string, string> = {
  invalid_email: "Enter a valid email address.",
  rate_limited: "Too many sign-in emails were requested. Wait a few minutes and try again.",
  link_invalid: "That sign-in link is invalid or has expired. Request a new one.",
  link_other_browser: "Open the sign-in link in the same browser where you requested it, or request a new link here.",
  unavailable: "Sign-in is temporarily unavailable. Try again shortly."
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const error = typeof params.error === "string" ? MESSAGES[params.error] : undefined;
  const sent = params.sent === "1";

  return (
    <main className="shell">
      <header className="topbar">
        <Logo variant="tagline" className="topbar-logo" />
      </header>
      <section className="hero">
        <p className="eyebrow">SIGN IN</p>
        <h1>Think beyond the<br /><em>next answer.</em></h1>
        <p className="hero-copy">We&rsquo;ll email you a one-time sign-in link. No password needed.</p>
      </section>
      <section className="panel" style={{ maxWidth: 480 }}>
        {sent && <div className="notice" role="status">If that address can sign in, a link is on its way. It expires in 15 minutes.</div>}
        {error && <div className="notice" role="alert">{error}</div>}
        <form method="post" action="/auth/sign-in" className="form-stack">
          <label>Email<input type="email" name="email" required maxLength={254} autoComplete="email" placeholder="you@company.com" /></label>
          <button type="submit">Email me a sign-in link <span>↗</span></button>
        </form>
      </section>
      <SiteFooter />
    </main>
  );
}
