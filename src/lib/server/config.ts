import { z } from "zod";
import type { PersistenceMode } from "@/lib/domain/types";

/**
 * Server-side configuration, validated once from process.env.
 * Error messages name variables and rules only, never values, so they are safe to log.
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
  persistence: PersistenceMode;
  databaseUrl: string | null;
};

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.preprocess(
    emptyToUndefined,
    z
      .url({ protocol: /^postgres(ql)?$/, error: "DATABASE_URL must be a postgres:// or postgresql:// URL" })
      .optional()
  ),
  ALLOW_IN_MEMORY_DEMO: z.preprocess(
    emptyToUndefined,
    z.enum(["true", "false"], { error: 'ALLOW_IN_MEMORY_DEMO must be "true" or "false"' }).default("false")
  )
});

export function parseServerConfig(env: Record<string, string | undefined>): ServerConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map(issue => issue.message));
  }
  const { NODE_ENV, DATABASE_URL, ALLOW_IN_MEMORY_DEMO } = parsed.data;

  if (DATABASE_URL) {
    return { nodeEnv: NODE_ENV, persistence: "postgres", databaseUrl: DATABASE_URL };
  }
  if (NODE_ENV === "production") {
    // Fail closed: production must never silently fall back to ephemeral storage.
    throw new ConfigError(["DATABASE_URL is required when NODE_ENV=production (in-memory demo storage is not allowed in production)"]);
  }
  if (ALLOW_IN_MEMORY_DEMO !== "true") {
    throw new ConfigError(["DATABASE_URL is required unless ALLOW_IN_MEMORY_DEMO=true (development/test only)"]);
  }
  return { nodeEnv: NODE_ENV, persistence: "in-memory-demo", databaseUrl: null };
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
