export type ReasoningStage = {
  stage: "frame" | "challenge" | "synthesize";
  title: string;
  content: string;
};

export type ReasoningResult = {
  summary: string;
  stages: ReasoningStage[];
  caveat: string;
};

/**
 * Deterministic placeholder for the first vertical slice.
 * This is NOT an LLM and must not be presented as production-grade reasoning.
 * Replace behind the ReasoningProvider interface once evaluations and budgets exist.
 */
export function runDeterministicThought(prompt: string): ReasoningResult {
  const cleaned = prompt.trim().replace(/\s+/g, " ");
  const question = cleaned.length > 360 ? `${cleaned.slice(0, 357)}...` : cleaned;

  const stages: ReasoningStage[] = [
    {
      stage: "frame",
      title: "Frame the decision",
      content: `Decision/question: ${question}\n\nDefine the desired outcome, deadline, affected people, constraints, and what a good decision would look like. Separate known facts from assumptions before choosing a path.`
    },
    {
      stage: "challenge",
      title: "Challenge assumptions",
      content: `Test the most important assumptions behind this question. What evidence would change your mind? Consider at least one alternative explanation, the cost of being wrong, reversibility, and the strongest argument against your preferred option.`
    },
    {
      stage: "synthesize",
      title: "Synthesize a next step",
      content: `Do not treat missing information as fact. List the 1–3 uncertainties that most affect the decision, gather the cheapest reliable evidence for them, then choose a small reversible next step with an owner, a deadline, and a measurable success signal.`
    }
  ];

  return {
    summary: `A first-pass thinking structure for: “${question}”`,
    stages,
    caveat: "Starter mode: this output is a deterministic scaffold, not model-generated analysis or verified research. Add evidence and connect an evaluated reasoning provider before relying on Echiche for consequential decisions."
  };
}
