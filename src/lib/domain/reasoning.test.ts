import { describe, expect, it } from "vitest";
import { runDeterministicThought } from "./reasoning";

describe("runDeterministicThought", () => {
  it("returns the three required stages and a clear caveat", () => {
    const result = runDeterministicThought("Should we launch our product to early customers?");
    expect(result.stages.map(stage => stage.stage)).toEqual(["frame", "challenge", "synthesize"]);
    expect(result.summary).toContain("Should we launch");
    expect(result.caveat).toContain("not model-generated");
  });

  it("bounds the question included in the summary", () => {
    const result = runDeterministicThought("a".repeat(1000));
    expect(result.summary.length).toBeLessThan(500);
  });

  it("normalizes excess whitespace", () => {
    const result = runDeterministicThought("  Should   we launch   this?  ");
    expect(result.summary).toContain("Should we launch this?");
  });
});
