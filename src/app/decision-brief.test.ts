import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DecisionBrief, RunEvidence } from "@/lib/domain/types";
import { DecisionBriefView, ScaffoldView } from "./decision-brief";

const brief: DecisionBrief = {
  decision_question: "Open a second office?", scope: "Next 12 months.",
  recommendation: { summary: "Not yet: pilot remotely.", rationale: "Fixed cost versus runway." },
  criteria_and_tradeoffs: [{ criterion: "Runway", tradeoff: "Office costs more." }],
  key_assumptions: [{ statement: "Customers will expand.", label: "hypothesis", confidence: "medium" }],
  supporting_evidence: [{ point: "Remote hiring works.", label: "inference", source_ids: ["S1", "S9"] }],
  counterevidence: [], strongest_objection: "A competitor may move first.",
  alternatives: [{ option: "Open now", why_not_now: "Unproven demand." }],
  confidence: { level: "medium", explanation: "Demand is assumed." },
  what_would_change: ["A customer commits."],
  next_actions: [{ action: "Open two remote roles.", success_signal: "Two offers in 8 weeks.", reversible: true }],
  citations: [{ source_id: "S1", supports: "remote hiring" }], proposed_memory_updates: [], limitations: []
};
const evidence: RunEvidence = {
  sources: [{ sourceId: "S1", url: "https://example.org/a", domain: "example.org", title: "Remote hiring", publisher: null,
    publishedAt: null, retrievedAt: "2026-10-29T10:00:00Z" }],
  claims: [{ claimId: "C1", text: "Remote hiring works.", label: "inference", status: "verified", freshness: "fresh", contradicted: false,
    links: [{ sourceId: "S1", passageId: "S1.p1", relation: "supports", quote: "Hired in seven weeks.", verdict: "supported" }] }]
} as unknown as RunEvidence;

describe("decision brief document", () => {
  const html = renderToStaticMarkup(h(DecisionBriefView, { brief, evidence, projectId: "p1" }));

  it("leads with the recommendation and its confidence", () => {
    expect(html.indexOf("Not yet: pilot remotely.")).toBeLessThan(html.indexOf("id=\"assumptions-title\""));
    expect(html).toContain("Confidence: medium");
  });

  it("links cited sources safely and only links source ids that were actually read", () => {
    expect(html).toContain('href="https://example.org/a" target="_blank" rel="noopener noreferrer nofollow"');
    expect(html).toContain('href="#source-S1"');
    expect(html).not.toContain('href="#source-S9"');
    expect(html).toContain("Supported by this quote");
  });

  it("says that labels are the model's assessment and that 'no limitations' means unverified", () => {
    expect(html).toContain("Labels are the model");
    expect(html).toContain("treat this as unverified analysis");
  });

  it("never presents the demo scaffold as a decision brief", () => {
    const scaffold = renderToStaticMarkup(h(ScaffoldView, { result: { summary: "A first-pass structure", stages: [], caveat: "Starter mode." } as never }));
    expect(scaffold).toContain("Starter structure, not a decision brief.");
    expect(scaffold).not.toContain("Recommendation");
  });
});
