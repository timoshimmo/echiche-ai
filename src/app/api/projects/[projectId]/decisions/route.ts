import { journalRoute } from "@/lib/server/journal-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The decision journal: all versions (newest first) with their outcomes. */
export const GET = journalRoute({
  route: "GET /api/projects/:projectId/decisions", param: "projectId", what: "Project", mutating: false, body: null,
  act: (repo, id) => repo.listDecisions(id)
});
