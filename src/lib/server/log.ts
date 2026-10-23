/**
 * Minimal structured logger: one JSON object per line on stdout/stderr.
 * Field names are shared with the Python worker (ADR-001 D7): run_id, project_id, stage, event, error_code.
 * Never pass prompts, problem statements, results, or raw driver error messages as fields.
 */
type Level = "info" | "warn" | "error";
type Fields = Record<string, string | number | boolean | null | undefined | string[]>;

export function log(level: Level, event: string, fields: Fields = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, service: "web", event, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}
