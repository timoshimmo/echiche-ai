import { outcomeSchema } from "@/lib/domain/memory";
import { journalRoute } from "@/lib/server/journal-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Record what happened after a decision. Appends; never rewrites the decision. */
export const POST = journalRoute({
  route: "POST /api/decisions/:decisionId/outcomes", param: "decisionId", what: "Decision", mutating: true, status: 201,
  body: outcomeSchema,
  invalid: "Provide result (as_expected, better, worse, mixed, too_early), observedOutcome (1–2000), observedOn (YYYY-MM-DD, not in the future) and optional notes.",
  act: (repo, id, input) => repo.addOutcome(id, input)
});
