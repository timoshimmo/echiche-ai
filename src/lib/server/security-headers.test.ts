import { describe, expect, it } from "vitest";
import nextConfig, { securityHeaders } from "../../../next.config";

const header = (env: string, key: string) => securityHeaders(env).find(h => h.key === key)?.value;

describe("browser security headers (M8 F3)", () => {
  it("apply to every path", async () => {
    const rules = await nextConfig.headers!();
    expect(rules).toEqual([{ source: "/:path*", headers: securityHeaders() }]);
  });

  it("forbid framing (clickjacking) in two independent ways", () => {
    expect(header("production", "Content-Security-Policy")).toMatch(/frame-ancestors 'none'/);
    expect(header("production", "X-Frame-Options")).toBe("DENY");
  });

  it("restrict scripts, plugins, base URLs and form targets to this origin", () => {
    const csp = header("production", "Content-Security-Policy")!;
    expect(csp).toMatch(/default-src 'self'/);
    expect(csp).toMatch(/script-src 'self' 'unsafe-inline'(;|$)/); // no 'unsafe-eval', no other hosts
    expect(csp).toMatch(/object-src 'none'/);
    expect(csp).toMatch(/base-uri 'none'/);
    expect(csp).toMatch(/form-action 'self'/);
    expect(csp).toMatch(/connect-src 'self'/);
    expect(csp).toMatch(/upgrade-insecure-requests/);
  });

  it("load fonts, styles and images from this origin only (self-hosted brand fonts, no Google Fonts)", () => {
    const csp = header("production", "Content-Security-Policy")!;
    expect(csp).toMatch(/font-src 'self'(;|$)/);
    expect(csp).toMatch(/style-src 'self' 'unsafe-inline'(;|$)/);
    expect(csp).toMatch(/img-src 'self' data:(;|$)/);
    expect(csp).not.toMatch(/googleapis|gstatic/);
  });

  it("send HSTS only in production and allow eval only in development (fast refresh)", () => {
    expect(header("production", "Strict-Transport-Security")).toMatch(/max-age=\d{8}/);
    expect(header("development", "Strict-Transport-Security")).toBeUndefined();
    expect(header("development", "Content-Security-Policy")).toMatch(/'unsafe-eval'/);
    expect(header("production", "X-Content-Type-Options")).toBe("nosniff");
  });
});
