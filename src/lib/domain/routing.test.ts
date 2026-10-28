import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classify, ROUTING_POLICY, routingPolicySchema, tierBudget, type RouteTier } from "./routing";

const cases: { id: string; prompt: string; hasMemory: boolean; expect: RouteTier }[] = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../evals/router-cases.v1.json", import.meta.url)), "utf8")
).cases;

describe("complexity router (ADR-010)", () => {
  it("is deterministic and explains every point of its score", () => {
    const input = { prompt: "Should we invest $200k to enter a new market against competitors?", depth: "auto" as const, hasMemory: false };
    const a = classify(input);
    expect(classify(input)).toEqual(a);
    expect(a.score).toBe(a.reasons.reduce((sum, r) => sum + r.points, 0));
    expect(a.tier).toBe("high");
    expect(a.reasons.find(r => r.signal === "consequence")?.detail).toMatch(/invest|an amount of money/);
  });

  it("lets the user's requested depth override the score, and says so", () => {
    const quick = classify({ prompt: "Should we invest $2m in a new factory?", depth: "quick", hasMemory: true });
    expect(quick.tier).toBe("low");
    expect(quick.reasons.at(-1)).toEqual({ signal: "requested_depth", points: 0, detail: "you asked for quick" });
    expect(classify({ prompt: "What did we decide?", depth: "deep", hasMemory: true }).tier).toBe("high");
  });

  it("caps budgets at the stricter of the operator's configuration and the tier", () => {
    const configured = { maxSteps: 18, maxActiveSeconds: 600, maxResearchCalls: 8, maxCostUsd: 0.5 };
    expect(tierBudget("low", configured)).toEqual({ maxSteps: 5, maxActiveSeconds: 180, maxResearchCalls: 0, maxCostUsd: 0.1 });
    expect(tierBudget("high", configured)).toEqual({ maxSteps: 12, maxActiveSeconds: 600, maxResearchCalls: 6, maxCostUsd: 0.5 });
  });

  it("rejects an invalid policy file", () => {
    expect(routingPolicySchema.safeParse({ ...ROUTING_POLICY, thresholds: { medium: "two" } }).success).toBe(false);
    const lowBelowStages = structuredClone(ROUTING_POLICY);
    lowBelowStages.tiers.low.budget.max_steps = 3; // fewer steps than pipeline stages
    expect(routingPolicySchema.safeParse(lowBelowStages).success).toBe(false);
  });

  it("agrees with the hand-labelled router cases (development set; gate: ≥ 90%, disagreements listed)", () => {
    const disagreements = cases
      .map(c => ({ ...c, got: classify({ prompt: c.prompt, depth: "auto", hasMemory: c.hasMemory }).tier }))
      .filter(c => c.got !== c.expect)
      .map(c => `${c.id}: expected ${c.expect}, got ${c.got}`);
    console.info(`router agreement ${cases.length - disagreements.length}/${cases.length}`, disagreements);
    expect((cases.length - disagreements.length) / cases.length).toBeGreaterThanOrEqual(0.9);
    // Known: R07 (a trivial either/or scheduling choice) routes to medium. Lexical signals can't tell trivial from weighty choices.
    expect(disagreements).toEqual(["R07: expected low, got medium"]);
  });
});

describe("evaluation benchmark stays in step with the router", () => {
  it("records the tier this router gives each benchmark case (the worker's routed variant uses it)", () => {
    type BenchCase = { id: string; prompt: string; route_tier: RouteTier; decision: unknown;
      memories: { status: string; other_project?: boolean }[] };
    const bench: { cases: BenchCase[] } = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../../evals/decision-benchmark.v1.json", import.meta.url)), "utf8"));
    const drift = bench.cases
      .map(c => ({ id: c.id, want: c.route_tier, got: classify({ prompt: c.prompt, depth: "auto",
        hasMemory: c.memories.some(m => m.status === "active" && !m.other_project) || c.decision !== null }).tier }))
      .filter(c => c.want !== c.got);
    expect(drift).toEqual([]);
  });
});

describe("router reasons", () => {
  it("quote the user's own words, not the stems the policy matches on", () => {
    const r = classify({ prompt: "Should we change our pricing before we sign the lease? Please advise.", depth: "auto", hasMemory: true });
    expect(r.reasons.find(x => x.signal === "consequence")?.detail).toBe("lease, pricing, sign");
    expect(r.reasons.find(x => x.signal === "consequence")?.points).toBe(4); // three terms → magnitude bonus
    // "lease" must not match inside "please", nor "sign" inside "design", nor "pric" inside "caprice".
    const polite = classify({ prompt: "Please could you help with the design of our caprice menu?", depth: "auto", hasMemory: true });
    expect(polite.reasons.find(x => x.signal === "consequence")).toBeUndefined();
  });
});
