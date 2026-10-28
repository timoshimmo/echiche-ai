import { correctMemorySchema } from "@/lib/domain/memory";
import { journalRoute } from "@/lib/server/journal-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Correct an active memory: creates a new version that supersedes it (history is kept). */
export const PATCH = journalRoute({
  route: "PATCH /api/memories/:memoryId", param: "memoryId", what: "Memory", mutating: true,
  body: correctMemorySchema, invalid: "Provide content (1–500 characters) and optionally kind and confidence.",
  act: (repo, id, input) => repo.correctMemory(id, input)
});

/** Permanently delete the memory and all its versions. */
export const DELETE = journalRoute({
  route: "DELETE /api/memories/:memoryId", param: "memoryId", what: "Memory", mutating: true, body: null,
  act: (repo, id) => repo.deleteMemory(id)
});
