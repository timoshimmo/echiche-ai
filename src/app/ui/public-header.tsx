import Link from "next/link";
import { Logo } from "./primitives";

/** Header for public pages (sign-in, privacy, terms): the logo, linking home. */
export function PublicHeader() {
  return (
    <header className="public-header">
      <Link href="/" prefetch={false} className="logo" aria-label="Echiche home"><Logo variant="tagline" className="topbar-logo" /></Link>
    </header>
  );
}
