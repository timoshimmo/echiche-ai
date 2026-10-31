# ADR-013: Password and Google sign-in, open sign-up

- Status: **Accepted** (2026-10-31). Decided by the product owner: replace emailed sign-in links with email and password, add Google sign-in, open sign-up to anyone, and send email only for password resets (and sign-up confirmation, below).
- Supersedes the magic-link part of ADR-004. Supabase Auth, server-side sessions in httpOnly cookies and `getUser()` verification on every request are unchanged.

## Decision
| Route | What it does |
|---|---|
| `POST /auth/sign-in` | Email + password (`signInWithPassword`). The same message for an unknown email and a wrong password. 10 failures per email and 30 per client IP in 15 minutes, counted before Supabase is asked. |
| `POST /auth/sign-up` | Creates an account. Password 12–72 bytes (bcrypt's limit), typed twice. With email confirmation on, no session until the address is confirmed, and an existing address gets the same answer. |
| `POST /auth/google` | Starts Google OAuth server-side with PKCE (`signInWithOAuth`, `skipBrowserRedirect`) and redirects to Google. POST only, origin-checked. |
| `POST /auth/forgot-password` | Emails a reset link to `/auth/callback?flow=recovery`. The same answer for every address. |
| `GET /auth/callback` | Completes Google, confirmation and recovery. Signs in only in the browser that started the flow (marker cookie, 1 hour; M8 F2). A confirmation link opened elsewhere has already confirmed the address, so the user is asked to sign in with the password. Recovery goes to `/reset-password`; everything else to `/`. Never a URL from the query. |
| `/reset-password`, `POST /auth/update-password` | New password for a signed-in user (after a reset link, or "Change password" in the account menu). |

Magic-link sign-in is removed. The callback refuses `magiclink`, `invite` and `email_change` links.

## Security notes
- **Email confirmation stays on for password sign-ups** (Supabase "Confirm email"). With open sign-up and confirmation off, anyone could register a victim's address with a password, and Supabase would later link the victim's Google sign-in to that pre-made account: the attacker would then hold a password to the victim's data (pre-account takeover). This is the one email besides resets; Google users never get it.
- **Rate limits:** Supabase sees every request from the web server's IP, so its per-IP limits can't tell users apart. The app-level failure limiter is in memory, which is correct for the pilot's single web instance; a second instance needs a shared store.
- **Spend:** open sign-up means strangers can run the model. The per-user ($2) and global ($15) daily ceilings (ADR-011) bound the cost; a CAPTCHA (Supabase Auth supports Turnstile/hCaptcha) is the next step if sign-up abuse appears.

## Operator setup (hosted Supabase)
1. **Authentication → Sign In / Providers → Email:**
   - Enable email provider and sign-ups.
   - Turn on **Confirm email**.
   - Set the minimum password length to 12.
2. **Google:**
   1. Create an OAuth client (type "Web application") in Google Cloud Console.
   2. Set its authorized redirect URI to `https://<project-ref>.supabase.co/auth/v1/callback`.
   3. Paste the client ID and secret into **Authentication → Sign In / Providers → Google** and enable it.
3. **Authentication → URL Configuration:** Site URL = `APP_ORIGIN`; Redirect URLs include `APP_ORIGIN/auth/callback` (query strings such as `?flow=recovery` are allowed by the wildcard match).
4. **Custom SMTP** (Resend, or similar) so confirmation and reset emails come from Echiche and aren't limited to a few an hour.
