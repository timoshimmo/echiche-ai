import { z } from "zod";

export const createProjectSchema = z.object({
  title: z.string().trim().min(2).max(120),
  problemStatement: z.string().trim().min(10).max(5000)
});

export const startRunSchema = z.object({
  prompt: z.string().trim().min(10).max(8000)
});

/** Route IDs are UUIDs. Anything else is treated as "not found" without touching storage. */
export const resourceIdSchema = z.uuid();
