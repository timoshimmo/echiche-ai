import { PasswordInput } from "../../ui/password-input";

export const dynamic = "force-dynamic";
export const metadata = { title: "Choose a new password" };

const MESSAGES: Record<string, string> = {
  weak_password: "Use a password of at least 12 characters (at most 72 bytes).",
  password_mismatch: "The two passwords don't match.",
  same_password: "Choose a password different from your current one.",
  unavailable: "Your password couldn't be changed just now. Try again shortly."
};

/** Reached from a password-reset link (or the account menu) with a signed-in session; middleware requires one. */
export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const error = typeof params.error === "string" ? MESSAGES[params.error] : undefined;
  return (
    <div className="narrow">
      <div className="page-head"><div>
        <p className="eyebrow">Account</p>
        <h1 className="display">Choose a new password</h1>
        <p className="lede">You&rsquo;ll use it with your email address to sign in.</p>
      </div></div>
      {error && <div className="notice notice-error" role="alert"><div className="notice-body">{error}</div></div>}
      <form method="post" action="/auth/update-password" className="card stack">
        <div className="field">
          <label className="field-label" htmlFor="password">New password</label>
          <PasswordInput id="password" name="password" autoComplete="new-password" minLength={12} describedBy="password-hint" />
          <span className="field-hint" id="password-hint">At least 12 characters.</span>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="confirm">Confirm new password</label>
          <PasswordInput id="confirm" name="confirm" autoComplete="new-password" minLength={12} />
        </div>
        <div><button type="submit" className="btn btn-primary">Save new password</button></div>
      </form>
    </div>
  );
}
