import { describe, expect, it } from "vitest";
import { ConfigError, isSupabaseSecretKey, parseServerConfig } from "./config";

// Placeholders only. The JWTs below are unsigned fixtures used to test role detection.
const jwt = (payload: object) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.c2ln`;
const BASE = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://echiche_web:placeholder@localhost:54322/postgres",
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_placeholder_placeholder"
};
const PROD = { ...BASE, NODE_ENV: "production", SUPABASE_URL: "https://abcdefgh.supabase.co", APP_ORIGIN: "https://app.example.com" };

function issuesOf(env: Record<string, string | undefined>): string[] {
  try {
    parseServerConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  throw new Error("expected ConfigError");
}

describe("parseServerConfig", () => {
  it("accepts a complete development config with defaults", () => {
    expect(parseServerConfig(BASE)).toEqual({
      nodeEnv: "development",
      databaseUrl: BASE.DATABASE_URL,
      supabaseUrl: "http://127.0.0.1:54321",
      supabasePublishableKey: BASE.SUPABASE_PUBLISHABLE_KEY,
      appOrigin: "http://localhost:3000",
      limits: { projectsPerHour: 30, runsPerHour: 20 },
      runBudget: {
        initial: { maxSteps: 18, maxActiveSeconds: 600, maxResearchCalls: 8, maxCostUsd: 0.5 },
        resumeIncrement: { maxSteps: 9, maxActiveSeconds: 300, maxResearchCalls: 4, maxCostUsd: 0.25 }
      },
      secureCookies: false
    });
  });

  it("accepts a complete production config and enables secure cookies", () => {
    const config = parseServerConfig({ ...PROD, RUN_CREATE_LIMIT_PER_HOUR: "5" });
    expect(config.secureCookies).toBe(true);
    expect(config.appOrigin).toBe("https://app.example.com");
    expect(config.limits.runsPerHour).toBe(5);
  });

  it("requires DATABASE_URL, SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in every environment", () => {
    expect(issuesOf({ NODE_ENV: "development" })).toEqual([
      "DATABASE_URL is required", "SUPABASE_URL is required", "SUPABASE_PUBLISHABLE_KEY is required"
    ]);
    expect(issuesOf({ ...BASE, DATABASE_URL: "  " })).toEqual(["DATABASE_URL is required"]);
  });

  it("has no in-memory fallback: the removed ALLOW_IN_MEMORY_DEMO flag changes nothing", () => {
    expect(issuesOf({ NODE_ENV: "development", ALLOW_IN_MEMORY_DEMO: "true" })[0]).toBe("DATABASE_URL is required");
  });

  it("refuses service-role / secret keys anywhere in the web environment", () => {
    expect(issuesOf({ ...BASE, SUPABASE_SERVICE_ROLE_KEY: "anything" })[0]).toMatch(/must not be set in the web app/);
    expect(issuesOf({ ...BASE, SUPABASE_SECRET_KEY: "sb_secret_x" })[0]).toMatch(/must not be set/);
    expect(issuesOf({ ...BASE, SUPABASE_PUBLISHABLE_KEY: "sb_secret_abcdefghijklmnopqrstuvwxyz" })[0]).toMatch(/secret\/service-role key/);
    expect(issuesOf({ ...BASE, SUPABASE_PUBLISHABLE_KEY: jwt({ role: "service_role", iss: "supabase" }) })[0]).toMatch(/secret\/service-role key/);
    expect(parseServerConfig({ ...BASE, SUPABASE_PUBLISHABLE_KEY: jwt({ role: "anon", iss: "supabase" }) }).nodeEnv).toBe("development");
  });

  it("requires https for Supabase except a local stack in development", () => {
    expect(issuesOf({ ...PROD, SUPABASE_URL: "http://127.0.0.1:54321" })[0]).toMatch(/must use https/);
    expect(issuesOf({ ...BASE, SUPABASE_URL: "http://supabase.internal" })[0]).toMatch(/must use https/);
  });

  it("requires an https APP_ORIGIN in production, origin only", () => {
    expect(issuesOf({ ...PROD, APP_ORIGIN: undefined })).toContain("APP_ORIGIN is required when NODE_ENV=production");
    expect(issuesOf({ ...PROD, APP_ORIGIN: "http://app.example.com" })).toContain("APP_ORIGIN must use https in production");
    expect(issuesOf({ ...BASE, APP_ORIGIN: "http://localhost:3000/app" })[0]).toMatch(/origin only/);
  });

  it("rejects malformed values without echoing them", () => {
    const issues = issuesOf({ ...BASE, DATABASE_URL: "mysql://root:SuperSecret@db/prod", RUN_CREATE_LIMIT_PER_HOUR: "0" });
    expect(issues.join(" ")).toMatch(/postgres:\/\/ or postgresql:\/\//);
    expect(issues.join(" ")).toMatch(/RUN_CREATE_LIMIT_PER_HOUR must be between 1 and 10000/);
    expect(issues.join(" ")).not.toContain("SuperSecret");
    expect(issuesOf({ ...BASE, RUN_BUDGET_MAX_STEPS: "0", RUN_BUDGET_MAX_COST_USD: "-1" })).toEqual([
      "RUN_BUDGET_MAX_STEPS must be between 1 and 1000", "RUN_BUDGET_MAX_COST_USD must be between 0 and 1000"
    ]);
    expect(() => parseServerConfig({ ...BASE, NODE_ENV: "staging" })).toThrow(ConfigError);
  });
});

describe("isSupabaseSecretKey", () => {
  it("detects new-style secret keys and legacy service_role JWTs", () => {
    expect(isSupabaseSecretKey("sb_secret_123")).toBe(true);
    expect(isSupabaseSecretKey(jwt({ role: "service_role" }))).toBe(true);
    expect(isSupabaseSecretKey(jwt({ role: "anon" }))).toBe(false);
    expect(isSupabaseSecretKey("sb_publishable_123")).toBe(false);
    expect(isSupabaseSecretKey("a.b.c")).toBe(false);
  });
});
