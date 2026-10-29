// Plain-language presentation of run state. Pure functions: every label comes from real run fields.
import { ROUTING_POLICY } from "@/lib/domain/routing";
import { RUN_STAGES, SETTLED_STATUSES, type RunStage, type RunStatus, type ThoughtRun } from "@/lib/domain/types";

export type Depth = "auto" | "quick" | "standard" | "deep";
export const DEPTHS: { value: Depth; label: string; hint: string }[] = [
  { value: "auto", label: "Automatic (recommended)", hint: "Echiche sizes the run to the question and shows why." },
  { value: "quick", label: "Quick", hint: "Frames and answers only: no web research, critique or verification." },
  { value: "standard", label: "Standard", hint: "Researches, critiques and verifies claims before the brief." },
  { value: "deep", label: "Deep", hint: "More research; may use a stronger model for the brief when sources conflict." }
];

type Tone = "neutral" | "success" | "warning" | "danger" | "focus" | "ink";
export const STATUS: Record<RunStatus, { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "neutral" },
  planning: { label: "Framing", tone: "focus" },
  researching: { label: "Researching", tone: "focus" },
  critiquing: { label: "Challenging", tone: "focus" },
  verifying: { label: "Verifying", tone: "focus" },
  synthesizing: { label: "Writing the brief", tone: "focus" },
  awaiting_user_review: { label: "Ready for your review", tone: "warning" },
  completed: { label: "Accepted", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  paused_for_budget: { label: "Paused: needs budget", tone: "warning" }
};

/** The five stages of a standard or deep run (RUN_STAGES), in user words. */
export const STAGES: Record<RunStage, { name: string; what: string }> = {
  planning: { name: "Frame", what: "Define the decision" },
  researching: { name: "Research", what: "Find evidence" },
  critiquing: { name: "Challenge", what: "Test assumptions" },
  verifying: { name: "Verify", what: "Check each claim" },
  synthesizing: { name: "Brief", what: "Recommend a next step" }
};

export const TIER_LABEL = { low: "Quick", medium: "Standard", high: "Deep" } as const;

export const isSettled = (status: RunStatus) => SETTLED_STATUSES.includes(status);
export const needsAttention = (run: Pick<ThoughtRun, "status">) => run.status === "awaiting_user_review" || run.status === "paused_for_budget";

/** Stages a tier leaves out (ADR-010); the worker checkpoints them as skipped. */
const ROUTED: Partial<Record<RunStage, "research" | "critique" | "verify">> = { researching: "research", critiquing: "critique", verifying: "verify" };
export function isSkipped(route: ThoughtRun["route"], stage: RunStage): boolean {
  const flag = ROUTED[stage];
  return !!(route.tier && flag && !ROUTING_POLICY.tiers[route.tier].pipeline[flag]);
}

export type StageState = "done" | "active" | "skipped" | "todo";
export function stageStates(run: Pick<ThoughtRun, "route" | "status" | "completedStages">): { stage: RunStage; state: StageState }[] {
  return RUN_STAGES.map(stage => ({
    stage,
    state: isSkipped(run.route, stage) ? "skipped"
      : run.completedStages.includes(stage) ? "done"
      : run.status === stage ? "active" : "todo"
  }));
}

/** One sentence on how the run was sized, without engineering terms. */
export function routeSummary(route: ThoughtRun["route"]): string | null {
  if (!route.tier) return null;
  const tier = TIER_LABEL[route.tier];
  const how = route.requestedDepth === "auto" ? "chosen automatically from your question" : "as you asked";
  const why = route.escalation ? [
    route.escalation.includes("contradiction") ? "sources disagreed" : "",
    route.escalation.includes("high_severity_critique") ? "a serious objection was raised" : ""
  ].filter(Boolean) : [];
  const escalation = route.escalation
    ? `; it used a stronger model for the brief${why.length ? ` because ${why.join(" and ")}` : ""}`
    : "";
  return `${tier} run, ${how}${escalation}.`;
}

/** The router's deterministic reasons, lightly humanised (kept for transparency). */
export function routeReasons(route: ThoughtRun["route"]): string[] {
  const reasons = route.reasons.map(r => `${r.detail} (${r.signal.replaceAll("_", " ")}, ${r.points >= 0 ? "+" : ""}${r.points})`);
  return [...(reasons.length ? reasons : ["No sizing signals matched."]), `Routing policy: ${route.policyVersion ?? "unknown"}`];
}

/** "29 Oct 2026" / "29 Oct 2026, 14:05" in the viewer's locale and time zone. */
export function formatDate(iso: string, withTime = false): string {
  // A bare calendar date ("2026-10-29") has no time zone: show it as written, not shifted to local time.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric", month: "short", year: "numeric",
    ...(dateOnly ? { timeZone: "UTC" } : withTime ? { hour: "2-digit", minute: "2-digit" } : {})
  });
}

/** "just now", "5 minutes ago", "3 days ago", then a date. */
export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} day${days === 1 ? "" : "s"} ago`;
  return formatDate(iso);
}

/** Title a run by what it produced: the brief's question, or the prompt the user typed. */
export function runTitle(run: Pick<ThoughtRun, "result" | "prompt">): string {
  if (run.result?.schemaVersion === "decision-brief.v1") return run.result.data.decision_question;
  return run.prompt;
}
