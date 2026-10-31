import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { SIGN_IN_COOKIE, signInCookieOptions } from "./auth";
import { getServerConfig } from "./config";
import { readTextCapped } from "./http";

/** Helpers shared by the /auth form routes (ADR-013). Plain HTML forms, so sign-in works without JavaScript. */

export const toLogin = (origin: string, query: string) => NextResponse.redirect(`${origin}/login${query ? `?${query}` : ""}`, 303);

/** The submitted form fields, or null when the body is larger than maxBytes. */
export async function readForm(request: Request, maxBytes = 4096): Promise<URLSearchParams | null> {
  const text = await readTextCapped(request, maxBytes);
  return text === null ? null : new URLSearchParams(text);
}

/**
 * Marks this browser as the one that started an email or Google flow, so the callback only completes it
 * here (login-CSRF defence, M8 F2). Set on every response that hands the user to Supabase or an email.
 */
export function withSignInMarker(response: NextResponse): NextResponse {
  response.cookies.set(SIGN_IN_COOKIE, randomBytes(32).toString("base64url"), signInCookieOptions(getServerConfig()));
  return response;
}

/** Client IP as seen by Render's proxy (first X-Forwarded-For hop), for rate limiting only. */
export function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

/**
 * Failed-password limiter. Supabase sees every request coming from this server's IP, so its own per-IP
 * limits cannot tell users apart; this counts failures per email and per client IP in a sliding window.
 * In memory: correct for the single web instance the pilot runs; a second instance would need a shared store.
 */
export class FailureLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly max: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const kept = (this.hits.get(key) ?? []).filter(t => t > cutoff);
    if (kept.length) this.hits.set(key, kept); else this.hits.delete(key);
    return kept;
  }
  blocked(key: string): boolean { return this.recent(key).length >= this.max; }
  fail(key: string): void { this.hits.set(key, [...this.recent(key), this.now()]); }
  clear(key: string): void { this.hits.delete(key); }
}

/** 10 failures per email and 30 per IP in 15 minutes. */
export const emailFailures = new FailureLimiter(10, 15 * 60_000);
export const ipFailures = new FailureLimiter(30, 15 * 60_000);
