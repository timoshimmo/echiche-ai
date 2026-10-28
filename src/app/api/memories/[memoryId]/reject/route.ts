import { journalRoute } from "@/lib/server/journal-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = journalRoute({
  route: "POST /api/memories/:memoryId/reject", param: "memoryId", what: "Memory", mutating: true, body: null,
  act: (repo, id) => repo.rejectMemory(id)
});
