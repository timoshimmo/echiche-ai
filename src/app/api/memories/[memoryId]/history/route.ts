import { journalRoute } from "@/lib/server/journal-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every version of this memory, oldest first, with what superseded what and when. */
export const GET = journalRoute({
  route: "GET /api/memories/:memoryId/history", param: "memoryId", what: "Memory", mutating: false, body: null,
  act: (repo, id) => repo.memoryHistory(id)
});
