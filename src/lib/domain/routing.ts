import { z } from "zod";
import rawPolicy from "../../../config/routing-policy.json";

/**
 * Deterministic complexity router (M7, ADR-010). No learned model: a few weighted, named
 * signals from config/routing-policy.json, summed and compared with thresholds. Every
 * decision carries the reasons that produced it, and the policy version.
 */
const tierSchema = z.object({
  label: z.string(),
  pipeline: z.object({ research: z.boolean(), critique: z.boolean(), verify: z.boolean(), memory: z.boolean(), allow_escalation: z.boolean() }).strict(),
  research: z.object({ max_queries: z.number().int().min(0).max(8), max_pages: z.number().int().min(0).max(12) }).strict(),
  budget: z.object({
    max_steps: z.number().int().min(5).max(1000), max_active_seconds: z.number().int().min(1).max(86400),
    max_research_calls: z.number().int().min(0).max(1000), max_cost_usd: z.number().min(0).max(1000)
  }).strict()
}).strict();

const termSignal = z.object({ weight: z.number(), description: z.string().optional(), terms: z.array(z.string().min(1)) }).strict();

export const routingPolicySchema = z.object({
  version: z.string().regex(/^routing-policy\.v[0-9]+$/),
  description: z.string(),
  signals: z.object({
    consequence: termSignal.extend({ magnitude_bonus: z.number(), money_pattern: z.string() }),
    comparison: termSignal,
    uncertainty: termSignal,
    evidence_need: termSignal,
    novelty: z.object({ weight: z.number(), description: z.string().optional() }).strict(),
    lookup: termSignal
  }).strict(),
  thresholds: z.object({ medium: z.number(), high: z.number() }).strict(),
  depth_overrides: z.object({ quick: z.literal("low"), standard: z.literal("medium"), deep: z.literal("high") }).strict(),
  tiers: z.object({ low: tierSchema, medium: tierSchema, high: tierSchema }).strict(),
  escalation: z.object({ description: z.string(), triggers: z.array(z.enum(["contradiction", "high_severity_critique"])) }).strict()
}).strict();

export type RoutingPolicy = z.infer<typeof routingPolicySchema>;
export type RouteTier = "low" | "medium" | "high";
export const REQUESTED_DEPTHS = ["auto", "quick", "standard", "deep"] as const;
export type RequestedDepth = (typeof REQUESTED_DEPTHS)[number];
export type RouteReason = { signal: string; points: number; detail: string };
export type RouteDecision = { tier: RouteTier; score: number; reasons: RouteReason[]; policyVersion: string };

/** Parsed once at module load: an invalid policy fails the build/tests, never a request. */
export const ROUTING_POLICY: RoutingPolicy = routingPolicySchema.parse(rawPolicy);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Terms match at the start of a word: "pric" matches "pricing", "lease" does not match "please".
 *  Returns, per matching term, the word as the user wrote it (so reasons read "pricing", not "pric"). */
function matches(text: string, terms: string[]): string[] {
  return terms.flatMap(term => {
    const found = new RegExp(`\\b${escape(term.toLowerCase())}[\\w-]*`, "i").exec(text);
    return found ? [found[0].toLowerCase()] : [];
  });
}
const unique = (words: string[]) => [...new Set(words)];

export function classify(
  input: { prompt: string; depth: RequestedDepth; hasMemory: boolean },
  policy: RoutingPolicy = ROUTING_POLICY
): RouteDecision {
  const text = ` ${input.prompt.toLowerCase().replace(/\s+/g, " ")} `;
  const s = policy.signals;
  const reasons: RouteReason[] = [];
  const consequence = matches(text, s.consequence.terms);
  const money = new RegExp(s.consequence.money_pattern, "i").test(text);
  if (consequence.length || money) {
    const bonus = consequence.length >= 2 || money ? s.consequence.magnitude_bonus : 0;
    reasons.push({ signal: "consequence", points: s.consequence.weight + bonus,
      detail: [...unique(consequence), ...(money ? ["an amount of money"] : [])].slice(0, 4).join(", ") });
  }
  const comparison = matches(text, s.comparison.terms);
  if (comparison.length) reasons.push({ signal: "comparison", points: s.comparison.weight, detail: unique(comparison).slice(0, 4).join(", ") });
  const uncertainty = matches(text, s.uncertainty.terms);
  if (uncertainty.length) reasons.push({ signal: "uncertainty", points: s.uncertainty.weight, detail: unique(uncertainty).slice(0, 4).join(", ") });
  const evidence = matches(text, s.evidence_need.terms);
  if (evidence.length) reasons.push({ signal: "evidence_need", points: s.evidence_need.weight, detail: unique(evidence).slice(0, 4).join(", ") });
  if (!input.hasMemory) reasons.push({ signal: "novelty", points: s.novelty.weight, detail: "no decision or remembered items yet for this project" });
  const lookup = matches(text, s.lookup.terms);
  if (lookup.length) reasons.push({ signal: "lookup", points: s.lookup.weight, detail: unique(lookup).slice(0, 3).join(", ") });

  const score = reasons.reduce((sum, r) => sum + r.points, 0);
  let tier: RouteTier = score >= policy.thresholds.high ? "high" : score >= policy.thresholds.medium ? "medium" : "low";
  if (input.depth !== "auto") {
    tier = policy.depth_overrides[input.depth];
    reasons.push({ signal: "requested_depth", points: 0, detail: `you asked for ${input.depth}` });
  }
  return { tier, score, reasons, policyVersion: policy.version };
}

/** The run's caps: the stricter of the operator's configured budget and the tier's budget. */
export function tierBudget(
  tier: RouteTier,
  configured: { maxSteps: number; maxActiveSeconds: number; maxResearchCalls: number; maxCostUsd: number },
  policy: RoutingPolicy = ROUTING_POLICY
) {
  const b = policy.tiers[tier].budget;
  return {
    maxSteps: Math.min(configured.maxSteps, b.max_steps),
    maxActiveSeconds: Math.min(configured.maxActiveSeconds, b.max_active_seconds),
    maxResearchCalls: Math.min(configured.maxResearchCalls, b.max_research_calls),
    maxCostUsd: Math.min(configured.maxCostUsd, b.max_cost_usd)
  };
}
