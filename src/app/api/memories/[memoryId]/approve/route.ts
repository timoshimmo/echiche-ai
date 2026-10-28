import { approveMemorySchema } from "@/lib/domain/memory";
import { journalRoute } from "@/lib/server/journal-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Approve a proposal (optionally edited first). Sensitive proposals need {"confirmSensitive": true}. */
export const POST = journalRoute({
  route: "POST /api/memories/:memoryId/approve", param: "memoryId", what: "Memory", mutating: true,
  body: approveMemorySchema, invalid: "Optional fields: content (1–500 characters), kind, confirmSensitive (boolean).",
  act: (repo, id, input) => repo.approveMemory(id, input)
});
