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

export const startRunSchema = z.object({ prompt: z.string().trim().min(10).max(8000) }).strict();

/** Route IDs are UUIDs. Anything else is treated as "not found" without touching storage. */
export const resourceIdSchema = z.uuid();

/** Magic-link sign-in form. */
export const signInSchema = z.object({ email: z.email().max(254) });
