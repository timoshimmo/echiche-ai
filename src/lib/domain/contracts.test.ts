import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { reasoningResultSchema } from "./reasoning";

// Cross-language contract check (ADR-001 D1). The JSON Schema is generated from the worker's
// Pydantic model; the fixtures are shared with the worker's tests. Both validators must agree.
const root = fileURLToPath(new URL("../../../contracts/", import.meta.url));
const read = (path: string) => JSON.parse(readFileSync(`${root}${path}`, "utf8"));

const generated = z.fromJSONSchema(read("reasoning-scaffold.v1.schema.json"));
const valid = read("fixtures/reasoning-scaffold.v1.valid.json");
const invalid: unknown[] = read("fixtures/reasoning-scaffold.v1.invalid.json");

describe("reasoning-scaffold.v1 contract", () => {
  it("accepts the shared valid fixture in both the generated schema and the Zod mirror", () => {
    expect(generated.safeParse(valid).success).toBe(true);
    expect(reasoningResultSchema.safeParse(valid).success).toBe(true);
  });

  it.each(invalid.map((fixture, i) => [i, fixture]))("rejects shared invalid fixture %i in both", (_i, fixture) => {
    expect(generated.safeParse(fixture).success).toBe(false);
    expect(reasoningResultSchema.safeParse(fixture).success).toBe(false);
  });
});
