/**
 * Runs once when the Next.js server starts (not during `next build`).
 * Validates configuration up front so a misconfigured deployment fails at boot
 * with a clear message instead of on the first request.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getServerConfig, ConfigError } = await import("@/lib/server/config");
  const { log } = await import("@/lib/server/log");
  try {
    const config = getServerConfig();
    log("info", "config_loaded", { node_env: config.nodeEnv, app_origin: config.appOrigin });
  } catch (error) {
    if (error instanceof ConfigError) {
      log("error", "config_invalid", { issues: error.issues });
      if (process.env.NODE_ENV === "production") process.exit(1);
      return; // development: keep serving so the error page/API explains the problem
    }
    throw error;
  }
}
