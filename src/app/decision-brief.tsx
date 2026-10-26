// Presentational only; types-only imports keep zod and server code out of the client bundle.
import type { DecisionBrief, GenerationSummary } from "@/lib/domain/types";

const PROVIDER_NAMES: Record<string, string> = { openai: "OpenAI" };
const LABELS: Record<string, string> = {
  fact: "Fact", inference: "Inference", hypothesis: "Hypothesis", speculation: "Speculation", unknown: "Unknown"
};

/** "Live model (OpenAI · gpt-6.1-sol)" or "Demo mode", from call telemetry rather than the payload. */
export function generationLabel(g: GenerationSummary): string {
  if (g.mode === "demo") return "Demo mode · deterministic scaffold, no AI model";
  const providers = g.providers.map(p => PROVIDER_NAMES[p] ?? p).join(", ");
  return `Live model (${providers} · ${g.models.join(", ")})`;
}

export function generationDetail(g: GenerationSummary): string | null {
  if (g.mode === "demo") return null;
  const repairs = g.repairs ? ` · ${g.repairs} repair${g.repairs === 1 ? "" : "s"}` : "";
  return `${g.calls} model call${g.calls === 1 ? "" : "s"}${repairs} · ${g.inputTokens.toLocaleString()} in / ${g.outputTokens.toLocaleString()} out tokens · $${g.costUsd.toFixed(4)} · prompts ${g.prompts.join(", ")}`;
}

function List({ items }: { items: string[] }) {
  return items.length ? <ul className="brief-list">{items.map((item, i) => <li key={i}>{item}</li>)}</ul> : <p className="brief-empty">None stated.</p>;
}

export function DecisionBriefView({ brief }: { brief: DecisionBrief }) {
  return (
    <div className="brief">
      <article className="stage-card brief-wide">
        <span className="stage-number">RECOMMENDATION · confidence {brief.confidence.level}</span>
        <h3>{brief.recommendation.summary}</h3>
        <p>{brief.recommendation.rationale}</p>
        <p className="brief-meta">{brief.confidence.explanation}</p>
      </article>
      <div className="stage-grid">
        <article className="stage-card"><span className="stage-number">SCOPE</span><p>{brief.scope}</p></article>
        <article className="stage-card"><span className="stage-number">STRONGEST OBJECTION</span><p>{brief.strongest_objection}</p></article>
        <article className="stage-card">
          <span className="stage-number">WHAT WOULD CHANGE THIS</span>
          <List items={brief.what_would_change} />
        </article>
        <article className="stage-card">
          <span className="stage-number">CRITERIA &amp; TRADE-OFFS</span>
          <List items={brief.criteria_and_tradeoffs.map(c => `${c.criterion}: ${c.tradeoff}`)} />
        </article>
        <article className="stage-card">
          <span className="stage-number">KEY ASSUMPTIONS</span>
          <List items={brief.key_assumptions.map(a => `${LABELS[a.label]} (${a.confidence}): ${a.statement}`)} />
        </article>
        <article className="stage-card">
          <span className="stage-number">ALTERNATIVES</span>
          <List items={brief.alternatives.map(a => `${a.option}: ${a.why_not_now}`)} />
        </article>
        <article className="stage-card">
          <span className="stage-number">SUPPORTING</span>
          <List items={brief.supporting_evidence.map(e => `${LABELS[e.label]}: ${e.point}`)} />
        </article>
        <article className="stage-card">
          <span className="stage-number">AGAINST</span>
          <List items={brief.counterevidence.map(e => `${LABELS[e.label]}: ${e.point}`)} />
        </article>
        <article className="stage-card">
          <span className="stage-number">NEXT ACTIONS</span>
          <List items={brief.next_actions.map(a => `${a.action} — success: ${a.success_signal}${a.reversible ? " (reversible)" : ""}`)} />
        </article>
      </div>
      {brief.proposed_memory_updates.length > 0 &&
        <div className="caveat"><strong>Proposed for project memory (not saved; review in a later release)</strong>
          <List items={brief.proposed_memory_updates.map(m => `${m.kind.replace("_", " ")}: ${m.statement}`)} /></div>}
      <div className="caveat"><strong>Limitations</strong>
        <List items={brief.limitations.length ? brief.limitations : ["None stated by the model; treat this as unverified analysis."]} />
        {brief.citations.length === 0 && <p>No sources were cited: Echiche does not perform research yet.</p>}
      </div>
    </div>
  );
}
