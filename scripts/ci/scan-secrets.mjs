// Fails if a tracked file looks like it contains a real credential (M8 security review).
// Usage: node scripts/ci/scan-secrets.mjs   (also run in CI). Placeholders used by tests are allowed.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PATTERNS = [
  ["OpenAI API key", /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/],
  ["Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["Brave Search key", /\bBSA[A-Za-z0-9_-]{25,}/],
  ["Supabase secret key", /\bsb_secret_[A-Za-z0-9_-]{30,}/],
  ["Private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["Postgres URL with a password", /postgres(?:ql)?:\/\/[^\s:@/'"`]+:([^\s@'"`]{8,})@(?!localhost|127\.0\.0\.1|db\.invalid|\[)/]
];
// Values tests and docs use on purpose. Anything matching a pattern must also match one of these to pass.
const ALLOWED = [/placeholder/i, /not-a-key/i, /test-only-password/, /example/i, /\$\{|<[A-Z_]+>|\[YOUR/];
// A synthetic service_role JWT is decoded in config.test.ts; it is built at runtime, never a literal.
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.(eyJ[A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g;

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const findings = [];
for (const file of files) {
  if (/\.(png|jpe?g|gif|ico|woff2?|docx|zip|pdf)$/i.test(file) || file.endsWith("package-lock.json") || file.endsWith("uv.lock")) continue;
  let text;
  try { text = readFileSync(file, "utf8"); } catch { continue; }
  text.split("\n").forEach((line, i) => {
    for (const [name, pattern] of PATTERNS) {
      const match = line.match(pattern);
      if (match && !ALLOWED.some(a => a.test(match[0]))) findings.push(`${file}:${i + 1}: ${name}`);
    }
    for (const m of line.matchAll(JWT)) {
      try {
        const payload = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8"));
        if (payload.role === "service_role" || payload.role === "supabase_admin") findings.push(`${file}:${i + 1}: service-role JWT`);
      } catch { /* not a JWT */ }
    }
  });
}
if (findings.length) {
  console.error(`scan-secrets: ${findings.length} possible credential(s) in tracked files:\n${findings.join("\n")}`);
  process.exit(1);
}
console.log(`scan-secrets: ${files.length} tracked files, no credentials found`);
