import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { evidenceClaimSchema, evidenceSourceSchema } from "./evidence";
import { decisionBriefSchema, parseRunResult, reasoningResultSchema } from "./reasoning";

// Cross-language contract check (ADR-001 D1). The JSON Schemas are generated from the worker's
// Pydantic models; the fixtures are shared with the worker's tests. Both validators must agree.
const root = fileURLToPath(new URL("../../../contracts/", import.meta.url));
const read = (path: string) => JSON.parse(readFileSync(`${root}${path}`, "utf8"));

describe("reasoning-scaffold.v1 contract", () => {
  const generated = z.fromJSONSchema(read("reasoning-scaffold.v1.schema.json"));
  const valid = read("fixtures/reasoning-scaffold.v1.valid.json");
  const invalid: unknown[] = read("fixtures/reasoning-scaffold.v1.invalid.json");

  it("accepts the shared valid fixture in both the generated schema and the Zod mirror", () => {
    expect(generated.safeParse(valid).success).toBe(true);
    expect(reasoningResultSchema.safeParse(valid).success).toBe(true);
  });

  it.each(invalid.map((fixture, i) => [i, fixture]))("rejects shared invalid fixture %i in both", (_i, fixture) => {
    expect(generated.safeParse(fixture).success).toBe(false);
    expect(reasoningResultSchema.safeParse(fixture).success).toBe(false);
  });
});

describe("decision-brief.v1 contract (M4)", () => {
  const generated = z.fromJSONSchema(read("decision-brief.v1.schema.json"));
  const valid = read("fixtures/decision-brief.v1.valid.json") as Record<string, unknown>;
  const invalid: unknown[] = read("fixtures/decision-brief.v1.invalid.json");

  it("accepts the shared valid fixture in both", () => {
    expect(generated.safeParse(valid).success).toBe(true);
    expect(decisionBriefSchema.safeParse(valid).success).toBe(true);
  });

  it.each(invalid.map((fixture, i) => [i, fixture]))("the mirror rejects shared invalid fixture %i", (_i, fixture) => {
    // String bounds live in Pydantic validators, not the JSON Schema, so only the mirror sees them.
    expect(decisionBriefSchema.safeParse(fixture).success).toBe(false);
  });

  it("both reject the structurally invalid fixtures", () => {
    const structural = invalid.filter(f => !generated.safeParse(f).success);
    expect(structural.length).toBeGreaterThanOrEqual(4);
  });

  it.each(Object.keys(valid))("both require top-level section %s", key => {
    const missing = { ...valid };
    delete missing[key];
    expect(generated.safeParse(missing).success).toBe(false);
    expect(decisionBriefSchema.safeParse(missing).success).toBe(false);
  });

  it("the mirror and the generated schema list the same top-level sections", () => {
    const schema = read("decision-brief.v1.schema.json") as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(decisionBriefSchema.shape).sort()).toEqual(Object.keys(schema.properties).sort());
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
  });
});

describe("parseRunResult", () => {
  it("dispatches on the stored schema version and rejects unknown versions or mismatched payloads", () => {
    const brief = read("fixtures/decision-brief.v1.valid.json");
    const scaffold = read("fixtures/reasoning-scaffold.v1.valid.json");
    expect(parseRunResult("decision-brief.v1", brief)?.schemaVersion).toBe("decision-brief.v1");
    expect(parseRunResult("reasoning-scaffold.v1", scaffold)?.schemaVersion).toBe("reasoning-scaffold.v1");
    expect(parseRunResult("decision-brief.v1", scaffold)).toBeNull();
    expect(parseRunResult("decision-brief.v2", brief)).toBeNull();
    expect(parseRunResult(null, brief)).toBeNull();
  });
});

describe("research evidence rows (M5)", () => {
  const source = {
    sourceId: "S1", url: "https://survey.example/report", domain: "survey.example", title: "Report", publisher: null,
    publishedAt: "2026-05-14", retrievedAt: "2026-10-28T10:00:00Z",
    passages: [{ passage_id: "S1.p1", text: "Clinics pay a median of 89 dollars per month." }]
  };
  it("accepts a well-formed source and rejects non-https links, bad IDs and oversize passages", () => {
    expect(evidenceSourceSchema.safeParse(source).success).toBe(true);
    for (const bad of [
      { ...source, url: "http://survey.example/report" },
      { ...source, url: "javascript:alert(1)" },
      { ...source, sourceId: "X1" },
      { ...source, passages: [{ passage_id: "S1.p1", text: "x".repeat(601) }] },
      { ...source, passages: [] }
    ]) expect(evidenceSourceSchema.safeParse(bad).success).toBe(false);
  });
  it("accepts a claim with links and rejects unknown verdicts", () => {
    const claim = {
      claimId: "C1", text: "Clinics pay.", label: "fact", status: "verified", freshness: "fresh", contradicted: false,
      links: [{ sourceId: "S1", passageId: "S1.p1", relation: "supports", quote: "median of 89 dollars", verdict: "supported", note: "ok" }]
    };
    expect(evidenceClaimSchema.safeParse(claim).success).toBe(true);
    expect(evidenceClaimSchema.safeParse({ ...claim, links: [{ ...claim.links[0], verdict: "true" }] }).success).toBe(false);
  });
});
