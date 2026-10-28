import { reviseDecisionSchema } from "@/lib/domain/memory";
import { journalRoute } from "@/lib/server/journal-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Revise the current decision: appends a new version; the earlier rationale stays in the journal. */
export const POST = journalRoute({
  route: "POST /api/decisions/:decisionId/revise", param: "decisionId", what: "Decision", mutating: true, status: 201,
  body: reviseDecisionSchema, invalid: "Provide choice (1–1000) and rationale (1–4000 characters); confidence is optional.",
  act: (repo, id, input) => repo.reviseDecision(id, input)
});
