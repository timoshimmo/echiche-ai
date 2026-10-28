// Presentational only; types-only imports keep zod and server code out of the client bundle.
import type { DecisionBrief, EvidenceClaim, EvidenceSource, GenerationSummary, RunEvidence } from "@/lib/domain/types";

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

const VERDICT: Record<string, string> = {
  supported: "supported", partially_supported: "partly supported", not_supported: "not supported", quote_not_found: "quote not found"
};

/** Only https URLs reach this point (validated server-side); links never pass a referrer or ranking signal. */
function SourceItem({ source, claims, cited }: { source: EvidenceSource; claims: EvidenceClaim[]; cited: string | undefined }) {
  const quotes = claims.flatMap(c =>
    c.links.filter(l => l.sourceId === source.sourceId && (l.verdict === "supported" || l.verdict === "partially_supported"))
      .map(l => ({ claim: c, link: l })));
  const meta = [source.publisher ?? source.domain, source.publishedAt ? `published ${source.publishedAt.slice(0, 10)}` : "date unknown",
    `read ${source.retrievedAt.slice(0, 10)}`].join(" · ");
  return (
    <li className="source-item">
      <span className="source-id">{source.sourceId}</span>
      <div>
        <a href={source.url} target="_blank" rel="noopener noreferrer nofollow">{source.title}</a>
        <small>{meta}</small>
        {cited && <p className="source-cited">Cited for: {cited}</p>}
        {quotes.map(({ claim, link }) =>
          <blockquote key={`${claim.claimId}-${link.passageId}`}>
            “{link.quote}”
            <small>{link.relation === "contradicts" ? "Contradicts" : "Supports"} {claim.claimId}: {claim.text} · {VERDICT[link.verdict]}
              {claim.freshness === "stale" ? " · stale source" : ""}{claim.contradicted ? " · sources disagree on this claim" : ""}</small>
          </blockquote>)}
      </div>
    </li>
  );
}

function EvidenceView({ brief, evidence }: { brief: DecisionBrief; evidence: RunEvidence }) {
  const cited = new Map(brief.citations.map(c => [c.source_id, c.supports]));
  const citedSources = evidence.sources.filter(s => cited.has(s.sourceId));
  const otherSources = evidence.sources.filter(s => !cited.has(s.sourceId));
  const rejected = evidence.claims.filter(c => c.status === "unsupported" || c.status === "invalid");
  const verified = evidence.claims.filter(c => c.status === "verified" || c.status === "partial");
  return (
    <div className="caveat sources">
      <strong>Sources ({evidence.sources.length} read · {verified.length} claim{verified.length === 1 ? "" : "s"} verified against them)</strong>
      {citedSources.length > 0 && <ol className="source-list">{citedSources.map(s =>
        <SourceItem key={s.sourceId} source={s} claims={evidence.claims} cited={cited.get(s.sourceId)} />)}</ol>}
      {otherSources.length > 0 && <details><summary>Read but not cited ({otherSources.length})</summary>
        <ol className="source-list">{otherSources.map(s =>
          <SourceItem key={s.sourceId} source={s} claims={evidence.claims} cited={undefined} />)}</ol></details>}
      {rejected.length > 0 && <details><summary>Claims that failed verification ({rejected.length})</summary>
        <List items={rejected.map(c => `${c.claimId}: ${c.text} (${c.status === "invalid" ? "quote not found in the source" : "not supported by the source"})`)} /></details>}
    </div>
  );
}

export function DecisionBriefView({ brief, evidence }: { brief: DecisionBrief; evidence?: RunEvidence }) {
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
        {brief.citations.length === 0 && <p>No sources are cited in this brief.</p>}
      </div>
      {evidence && evidence.sources.length > 0 && <EvidenceView brief={brief} evidence={evidence} />}
    </div>
  );
}
