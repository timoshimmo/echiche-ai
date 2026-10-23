import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Echiche — Deep Thought, with continuity",
  description: "A first working slice of Echiche: structured thinking runs connected to projects."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
