import type { Metadata, Viewport } from "next";
// Brand typefaces, self-hosted (SIL OFL 1.1). Only the latin subsets a page uses are downloaded.
import "@fontsource-variable/instrument-sans/wght.css";
import "@fontsource-variable/fraunces/wght.css";
import "./globals.css";

// Tab icon, Apple touch icon and favicon come from the logo kit via the file conventions
// src/app/icon.svg, apple-icon.png and favicon.ico.
export const metadata: Metadata = {
  title: { default: "Echiche · Think Further.", template: "%s · Echiche" },
  description: "Echiche helps you work through important decisions and keeps the context behind them.",
  applicationName: "Echiche",
  // The pilot is invitation-only; keep it out of search results. (The social preview image is in
  // public/brand for when the app has a public page and a fixed metadataBase.)
  robots: { index: false, follow: false }
};

export const viewport: Viewport = { themeColor: "#FAF9F4", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
