"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { CurrentUser } from "@/lib/domain/types";
import { api } from "../lib/api";
import { SiteFooter } from "../site-footer";
import { Logo } from "./primitives";

const NAV = [
  { href: "/", label: "Overview", match: (p: string) => p === "/" },
  { href: "/projects", label: "Projects", match: (p: string) => p.startsWith("/projects") }
];

/** Signed-in frame: brand, the two destinations, and an account menu (email + sign out). */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const [user, setUser] = useState<CurrentUser | null>(null);
  useEffect(() => { api<CurrentUser>("/api/me").then(setUser).catch(() => {}); }, []);

  return (
    <>
      <a href="#main" className="skip-link">Skip to content</a>
      <header className="app-header">
        <div className="app-header-inner">
          <Link href="/" className="logo" aria-label="Echiche overview">
            <Logo className="logo-full" />
            <Logo variant="symbol" className="logo-compact" />
          </Link>
          <nav aria-label="Main" className="app-nav">
            {NAV.map(item => (
              <Link key={item.href} href={item.href} className="app-nav-link" aria-current={item.match(pathname) ? "page" : undefined}>{item.label}</Link>
            ))}
          </nav>
          <AccountMenu email={user?.email ?? null} />
        </div>
      </header>
      <main id="main" className="app-main" tabIndex={-1}>{children}</main>
      <div className="app-footer"><SiteFooter /></div>
    </>
  );
}

function AccountMenu({ email }: { email: string | null }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  const initial = (email ?? "?").slice(0, 1).toUpperCase();
  return (
    <div className="account" ref={root}>
      <button type="button" className="account-button" aria-expanded={open} aria-haspopup="true" aria-controls="account-menu" onClick={() => setOpen(o => !o)}>
        <span className="avatar" aria-hidden="true">{initial}</span>
        <span className="visually-hidden">Account</span>
      </button>
      {open && (
        <div className="account-menu" id="account-menu">
          <p className="account-label">Signed in as</p>
          <p className="account-email">{email ?? "your account"}</p>
          <form method="post" action="/auth/sign-out">
            <button type="submit" className="btn btn-secondary btn-sm btn-block">Sign out</button>
          </form>
        </div>
      )}
    </div>
  );
}
