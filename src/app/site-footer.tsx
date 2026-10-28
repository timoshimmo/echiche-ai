import Link from "next/link";
import { SUPPORT } from "@/lib/domain/site";

/** Shown on every page: pilot status, the advice disclaimer, legal links and the support contact. */
export function SiteFooter() {
  return (
    <footer className="site-footer">
      <p className="pilot-notice">
        <strong>Early pilot.</strong> Echiche is decision support, not professional advice: it can be wrong or incomplete,
        and it does not replace legal, financial, medical or other qualified advice. You stay responsible for your decisions.
      </p>
      <nav aria-label="Legal and support">
        <Link href="/privacy">Privacy notice</Link>
        <Link href="/terms">Terms</Link>
        <a href={`mailto:${SUPPORT.email}`}>{SUPPORT.email}</a>
        <a href={SUPPORT.phoneHref}>{SUPPORT.phone}</a>
      </nav>
    </footer>
  );
}
