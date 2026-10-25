#!/usr/bin/env node
// CI-only check against a LOCAL Supabase stack (`supabase start`): proves the property
// the app relies on for AUTH-01 ("logout invalidates session"): after sign-out, the
// Auth server's GET /user (what getUser() calls) rejects the old access token.
//
//   eval "$(npx supabase status -o env)" && API_URL=$API_URL ANON_KEY=$ANON_KEY \
//     SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY node scripts/ci/verify-auth-revocation.mjs
//
// The service-role key is used here only to create a throwaway user in the local stack.
const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = process.env;
if (!API_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
  console.error("verify-auth-revocation: API_URL, ANON_KEY and SERVICE_ROLE_KEY are required (from `supabase status -o env`).");
  process.exit(2);
}
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(API_URL)) {
  console.error("verify-auth-revocation: refusing to run against a non-local Supabase.");
  process.exit(2);
}

const auth = `${API_URL}/auth/v1`;
const email = `ci-${crypto.randomUUID()}@example.test`;
const password = `ci-${crypto.randomUUID()}`;

async function call(path, { method = "GET", key = ANON_KEY, token, body } = {}) {
  const response = await fetch(`${auth}${path}`, {
    method,
    headers: { apikey: key, authorization: `Bearer ${token ?? key}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

function expect(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`ok    ${message}`);
}

const created = await call("/admin/users", { method: "POST", key: SERVICE_ROLE_KEY, body: { email, password, email_confirm: true } });
expect(created.status === 200, `created throwaway user (status ${created.status})`);

const signedIn = await call("/token?grant_type=password", { method: "POST", body: { email, password } });
expect(signedIn.status === 200 && signedIn.json?.access_token, "signed in");
const token = signedIn.json.access_token;

expect((await call("/user", { token })).status === 200, "GET /user accepts the live session");

const loggedOut = await call("/logout?scope=local", { method: "POST", token });
expect(loggedOut.status === 204, `logout succeeded (status ${loggedOut.status})`);

const after = await call("/user", { token });
expect(after.status >= 400 && after.status < 500, `GET /user rejects the signed-out session's still-unexpired token (status ${after.status})`);

await call(`/admin/users/${created.json.id}`, { method: "DELETE", key: SERVICE_ROLE_KEY });
console.log("verify-auth-revocation: passed");
