import { describe, expect, it } from "vitest";
import { ConfigError, parseServerConfig } from "./config";

const URL_OK = "postgresql://echiche:placeholder@localhost:5432/echiche";

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
  it("uses postgres when DATABASE_URL is a valid postgres URL", () => {
    expect(parseServerConfig({ NODE_ENV: "production", DATABASE_URL: URL_OK })).toEqual({
      nodeEnv: "production", persistence: "postgres", databaseUrl: URL_OK
    });
    expect(parseServerConfig({ DATABASE_URL: "postgres://u:p@h/db" }).persistence).toBe("postgres");
  });

  it("refuses in-memory storage in production even when explicitly allowed", () => {
    expect(issuesOf({ NODE_ENV: "production", ALLOW_IN_MEMORY_DEMO: "true" })[0]).toMatch(/DATABASE_URL is required when NODE_ENV=production/);
  });

  it("fails closed by default when DATABASE_URL is missing", () => {
    expect(issuesOf({ NODE_ENV: "development" })[0]).toMatch(/ALLOW_IN_MEMORY_DEMO=true/);
  });

  it("treats a blank DATABASE_URL as missing", () => {
    expect(parseServerConfig({ NODE_ENV: "development", DATABASE_URL: "   ", ALLOW_IN_MEMORY_DEMO: "true" }).persistence).toBe("in-memory-demo");
  });

  it("allows in-memory demo storage outside production only when opted in", () => {
    expect(parseServerConfig({ NODE_ENV: "test", ALLOW_IN_MEMORY_DEMO: "true" })).toEqual({
      nodeEnv: "test", persistence: "in-memory-demo", databaseUrl: null
    });
  });

  it("rejects malformed DATABASE_URL values without echoing them", () => {
    const secret = "mysql://root:SuperSecret@db/prod";
    const issues = issuesOf({ DATABASE_URL: secret });
    expect(issues.join(" ")).toMatch(/postgres:\/\/ or postgresql:\/\//);
    expect(issues.join(" ")).not.toContain("SuperSecret");
    expect(issuesOf({ DATABASE_URL: "not a url" }).length).toBe(1);
  });

  it("rejects malformed flags and NODE_ENV", () => {
    expect(issuesOf({ ALLOW_IN_MEMORY_DEMO: "yes" })[0]).toMatch(/"true" or "false"/);
    expect(() => parseServerConfig({ NODE_ENV: "staging", DATABASE_URL: URL_OK })).toThrow(ConfigError);
  });
});
