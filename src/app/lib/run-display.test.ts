import { describe, expect, it } from "vitest";
import type { ThoughtRun } from "@/lib/domain/types";
import { formatDate, needsAttention, relativeTime, routeSummary, runTitle, stageStates } from "./run-display";

const route = (over: Partial<ThoughtRun["route"]> = {}): ThoughtRun["route"] =>
  ({ requestedDepth: "auto", tier: "medium", reasons: [], policyVersion: "routing-policy.v1", escalation: null, ...over });

describe("run display (plain-language labels from real run fields)", () => {
  it("derives each stage's state from completed checkpoints, the live status and the tier", () => {
    const states = stageStates({ route: route(), status: "critiquing", completedStages: ["planning", "researching"] });
    expect(states.map(s => s.state)).toEqual(["done", "done", "active", "todo", "todo"]);
    const quick = stageStates({ route: route({ tier: "low", requestedDepth: "quick" }), status: "synthesizing", completedStages: ["planning"] });
    expect(quick.map(s => s.state)).toEqual(["done", "skipped", "skipped", "skipped", "active"]);
  });

  it("explains routing without engineering terms, including both escalation reasons", () => {
    expect(routeSummary(route())).toBe("Standard run, chosen automatically from your question.");
    expect(routeSummary(route({ tier: "high", requestedDepth: "deep", escalation: "contradiction,high_severity_critique" })))
      .toBe("Deep run, as you asked; it used a stronger model for the brief because sources disagreed and a serious objection was raised.");
    expect(routeSummary(route({ tier: null }))).toBeNull();
  });

  it("flags only runs that wait on the user", () => {
    expect(needsAttention({ status: "awaiting_user_review" })).toBe(true);
    expect(needsAttention({ status: "paused_for_budget" })).toBe(true);
    expect(needsAttention({ status: "researching" })).toBe(false);
    expect(needsAttention({ status: "completed" })).toBe(false);
  });

  it("formats relative times and keeps bare calendar dates on the day they name", () => {
    const now = Date.parse("2026-10-29T12:00:00Z");
    expect(relativeTime("2026-10-29T11:59:40Z", now)).toBe("just now");
    expect(relativeTime("2026-10-29T11:55:00Z", now)).toBe("5 minutes ago");
    expect(relativeTime("2026-10-26T12:00:00Z", now)).toBe("3 days ago");
    expect(formatDate("2026-10-29")).toMatch(/29/);
  });

  it("titles a run by its brief's question when there is one", () => {
    expect(runTitle({ prompt: "typed prompt", result: null })).toBe("typed prompt");
  });
});
