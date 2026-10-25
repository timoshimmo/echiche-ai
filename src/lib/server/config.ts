import { z } from "zod";

/**
 * Web-app configuration, validated once from process.env. Fails closed.
 * Error messages name variables and rules only, never values, so they are safe to log.
 * Imported by middleware (edge runtime): keep it free of Node-only APIs.
 */
export class ConfigError extends Error {
  readonly code = "CONFIG_INVALID";
  constructor(readonly issues: string[]) {
    super(`Invalid server configuration: ${issues.join("; ")}`);
    this.name = "ConfigError";
  }
}

export type ServerConfig = {
  nodeEnv: "development" | "test" | "production";
  databaseUrl: string;
  supabaseUrl: string;
  /** Public by design (Supabase "publishable"/anon key), but only ever used server-side here. */
  supabasePublishableKey: string;
  /** Exact origin the app is served from; used for CSRF origin checks and auth redirects. */
  appOrigin: string;
  limits: { projectsPerHour: number; runsPerHour: number };
  secureCookies: boolean;
};

/** Variables that must never be present in the web app's environment. */
const FORBIDDEN_SECRETS = ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY", "SERVICE_ROLE_KEY"];
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const blankToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema.optional());
/** Error message that distinguishes "missing" from "malformed" without echoing the value. */
const msg = (name: string, rule: string) => (issue: { input?: unknown }) =>
  issue.input === undefined ? `${name} is required` : rule;
const limit = (name: string, fallback: number) =>
  z.preprocess(
    blankToUndefined,
    z.coerce.number({ error: `${name} must be a number` }).int(`${name} must be an integer`)
      .min(1, `${name} must be between 1 and 10000`).max(10000, `${name} must be between 1 and 10000`).default(fallback)
  );

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.preprocess(
    blankToUndefined,
    z.url({ protocol: /^postgres(ql)?$/, error: msg("DATABASE_URL", "DATABASE_URL must be a postgres:// or postgresql:// URL") })
  ),
  SUPABASE_URL: z.preprocess(
    blankToUndefined,
    z.url({ protocol: /^https?$/, error: msg("SUPABASE_URL", "SUPABASE_URL must be an http(s) URL") })
  ),
  SUPABASE_PUBLISHABLE_KEY: z.preprocess(
    blankToUndefined,
    z.string({ error: msg("SUPABASE_PUBLISHABLE_KEY", "SUPABASE_PUBLISHABLE_KEY must be a string") })
      .trim().min(20, "SUPABASE_PUBLISHABLE_KEY looks too short")
  ),
  APP_ORIGIN: optional(z.url({ protocol: /^https?$/, error: "APP_ORIGIN must be an http(s) URL" })),
  PROJECT_CREATE_LIMIT_PER_HOUR: limit("PROJECT_CREATE_LIMIT_PER_HOUR", 30),
  RUN_CREATE_LIMIT_PER_HOUR: limit("RUN_CREATE_LIMIT_PER_HOUR", 20)
});

/** True if `key` is a Supabase secret/service-role key rather than a publishable/anon key. */
export function isSupabaseSecretKey(key: string): boolean {
  if (key.startsWith("sb_secret_")) return true;
  const parts = key.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))) as { role?: unknown };
    return payload.role === "service_role";
  } catch {
    return false;
  }
}

export function parseServerConfig(env: Record<string, string | undefined>): ServerConfig {
  const issues: string[] = [];
  for (const name of FORBIDDEN_SECRETS) {
    if (env[name]?.trim()) issues.push(`${name} must not be set in the web app environment (it bypasses all data security)`);
  }

  const parsed = envSchema.safeParse(env);
  if (!parsed.success) issues.push(...parsed.error.issues.map(issue => issue.message));
  if (!parsed.success) throw new ConfigError(issues);

  const e = parsed.data;
  const production = e.NODE_ENV === "production";

  if (isSupabaseSecretKey(e.SUPABASE_PUBLISHABLE_KEY)) {
    issues.push("SUPABASE_PUBLISHABLE_KEY is a secret/service-role key; use the publishable (anon) key");
  }
  const supabaseUrl = new URL(e.SUPABASE_URL);
  if (supabaseUrl.protocol === "http:" && (production || !LOCAL_HOSTS.has(supabaseUrl.hostname))) {
    issues.push("SUPABASE_URL must use https (plain http is allowed only for a local Supabase in development)");
  }

  let appOrigin = "http://localhost:3000";
  if (e.APP_ORIGIN) {
    const url = new URL(e.APP_ORIGIN);
    if (url.origin !== e.APP_ORIGIN.replace(/\/$/, "")) issues.push("APP_ORIGIN must be an origin only (scheme://host[:port], no path)");
    if (production && url.protocol !== "https:") issues.push("APP_ORIGIN must use https in production");
    appOrigin = url.origin;
  } else if (production) {
    issues.push("APP_ORIGIN is required when NODE_ENV=production");
  }

  if (issues.length) throw new ConfigError(issues);
  return {
    nodeEnv: e.NODE_ENV,
    databaseUrl: e.DATABASE_URL,
    supabaseUrl: supabaseUrl.origin,
    supabasePublishableKey: e.SUPABASE_PUBLISHABLE_KEY,
    appOrigin,
    limits: { projectsPerHour: e.PROJECT_CREATE_LIMIT_PER_HOUR, runsPerHour: e.RUN_CREATE_LIMIT_PER_HOUR },
    secureCookies: production
  };
}

let cached: ServerConfig | undefined;

/** Parses process.env on first use and caches the result. Throws ConfigError when invalid. */
export function getServerConfig(): ServerConfig {
  cached ??= parseServerConfig(process.env);
  return cached;
}

/** Test helper: forget the cached config so a changed process.env is re-read. */
export function resetServerConfigForTests(): void {
  cached = undefined;
}
