import { describe, expect, it } from "vitest";
import { createProjectSchema, startRunSchema } from "./validation";

describe("request validation", () => {
  it("accepts a valid project", () => {
    expect(createProjectSchema.safeParse({ title: "Launch plan", problemStatement: "Decide how to launch to first users." }).success).toBe(true);
  });
  it("rejects short project descriptions", () => {
    expect(createProjectSchema.safeParse({ title: "Hi", problemStatement: "Too short" }).success).toBe(false);
  });
  it("rejects prompts that are too short", () => {
    expect(startRunSchema.safeParse({ prompt: "Why?" }).success).toBe(false);
  });
});
