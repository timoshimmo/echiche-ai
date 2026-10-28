import { journalRoute } from "@/lib/server/journal-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Download everything stored for the project as JSON (EXPORT-01). Generated on request; nothing is cached. */
export const GET = journalRoute({
  route: "GET /api/projects/:projectId/export", param: "projectId", what: "Project", mutating: false, usage: "export", body: null,
  act: async (repo, id) => {
    const data = await repo.exportProject(id);
    if (!data) return null;
    const date = new Date().toISOString().slice(0, 10);
    return new Response(JSON.stringify(data, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="echiche-project-${id}-${date}.json"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
      }
    });
  }
});
