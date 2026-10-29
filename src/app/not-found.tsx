import Link from "next/link";
import { SiteFooter } from "./site-footer";
import { PublicHeader } from "./ui/public-header";

export const metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <div className="public-page">
      <PublicHeader />
      <main id="main" className="legal">
        <h1>Page not found</h1>
        <p>The page you asked for does not exist or has moved.</p>
        <p><Link href="/">Go to Echiche</Link></p>
      </main>
      <SiteFooter />
    </div>
  );
}
