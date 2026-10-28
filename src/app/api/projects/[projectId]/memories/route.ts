import { createMemorySchema, memoryFilterSchema } from "@/lib/domain/memory";
import { apiError } from "@/lib/server/http";
import { journalRoute } from "@/lib/server/journal-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List memories. Query: status (proposed|active|superseded|rejected|all; default active), kind, q (substring). */
export const GET = journalRoute({
  route: "GET /api/projects/:projectId/memories", param: "projectId", what: "Project", mutating: false, body: null,
  act: async (repo, projectId, _input, request) => {
    const params = Object.fromEntries(new URL(request.url).searchParams);
    const filter = memoryFilterSchema.safeParse(params);
    if (!filter.success) return apiError("VALIDATION_ERROR", "Use status, kind and q (1–200 characters) only.", 400);
    return repo.listMemories(projectId, filter.data);
  }
});

/** Add a memory directly (the user's own statement: active immediately). */
export const POST = journalRoute({
  route: "POST /api/projects/:projectId/memories", param: "projectId", what: "Project", mutating: true, status: 201,
  body: createMemorySchema, invalid: "Provide kind (goal, constraint, assumption, decision, open_question, fact) and content (1–500 characters).",
  act: (repo, projectId, input) => repo.createMemory(projectId, input)
});
