import "./zod-setup";
import { z } from "zod";

const title = z.string().trim().min(2).max(120);
const problemStatement = z.string().trim().min(10).max(5000);

// .strict(): unknown keys are rejected, so a client cannot smuggle e.g. ownerUserId.
export const createProjectSchema = z.object({ title, problemStatement }).strict();

export const updateProjectSchema = z
  .object({ title: title.optional(), problemStatement: problemStatement.optional(), archived: z.boolean().optional() })
  .strict()
  .refine(v => v.title !== undefined || v.problemStatement !== undefined || v.archived !== undefined, {
    message: "Provide at least one field"
  });

/** depth: "auto" (default) lets the router decide; quick / standard / deep override it (ADR-010). */
export const startRunSchema = z
  .object({ prompt: z.string().trim().min(10).max(8000), depth: z.enum(["auto", "quick", "standard", "deep"]).optional() })
  .strict();

/** Route IDs are UUIDs. Anything else is treated as "not found" without touching storage. */
export const resourceIdSchema = z.uuid();

/** Optional Idempotency-Key header for run creation (same rule as the DB check). */
export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);

/** Magic-link sign-in form. */
export const signInSchema = z.object({ email: z.email().max(254) });
