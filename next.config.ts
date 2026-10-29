import type { NextConfig } from "next";

/**
 * Browser security headers on every response (M8 security review, finding F3).
 * - frame-ancestors / X-Frame-Options: nobody may frame the app (clickjacking on "Delete project").
 * - CSP: scripts, styles, fonts, images and requests come from this origin only. The brand
 *   typefaces are self-hosted (UI phase, Stage 2), so no third-party font origin. Next.js's App Router bootstraps with inline scripts, so script-src needs
 *   'unsafe-inline' (no nonce pipeline yet); React's output escaping remains the XSS defence, and
 *   the CSP still blocks loading scripts from anywhere else, plugins, <base> hijacking and
 *   off-origin form posts. Development also needs 'unsafe-eval' for fast refresh.
 * - HSTS only in production (local development is plain http).
 */
export function securityHeaders(env: string | undefined = process.env.NODE_ENV): { key: string; value: string }[] {
  const production = env === "production";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${production ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    ...(production ? ["upgrade-insecure-requests"] : [])
  ].join("; ");
  return [
    { key: "Content-Security-Policy", value: csp },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    ...(production ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }] : [])
  ];
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders() }];
  }
};

export default nextConfig;
