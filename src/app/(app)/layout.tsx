import { AppShell } from "../ui/app-shell";

/** Every signed-in screen shares the app shell. Middleware has already required a session. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
