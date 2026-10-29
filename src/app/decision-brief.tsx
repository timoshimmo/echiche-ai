// Presentational only; types-only imports keep zod and server code out of the client bundle.
// The brief is laid out as a decision document: recommendation first, then the reasoning to inspect it.
import Link from "next/link";
import type {
  DecisionBrief, EvidenceClaim, EvidenceSource, GenerationSummary, ReasoningResult, RememberedContext, RunEvidence
} from "@/lib/domain/types";
import { formatDate } from "./lib/run-display";
import { Badge } from "./ui/primitives";

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

const anchor = (sourceId: string) => `source-${sourceId.replace(/[^A-Za-z0-9_-]/g, "")}`;

function Label({ label }: { label: string }) {
  return <span className={`label-tag label-${label}`}>{LABELS[label] ?? label}</span>;
}

function None() { return <p className="muted">None stated.</p>; }

function SourceRefs({ ids, known }: { ids: string[]; known: Set<string> }) {
  if (!ids.length) return null;
  return <span className="source-refs">{ids.map(id => known.has(id)
    ? <a key={id} href={`#${anchor(id)}`} className="source-chip" aria-label={`Source ${id}`}>{id}</a>
    : <span key={id} className="source-chip muted" title="Not among the sources read for this run">{id}</span>)}</span>;
}

const VERDICT: Record<string, { label: string; tone: "success" | "warning" | "danger" }> = {
  supported: { label: "Supported by this quote", tone: "success" },
  partially_supported: { label: "Partly supported", tone: "warning" },
  not_supported: { label: "Not supported", tone: "danger" },
  quote_not_found: { label: "Quote not found", tone: "danger" }
};

/** Only https URLs reach this point (validated server-side); links never pass a referrer or ranking signal. */
function SourceItem({ source, claims, cited }: { source: EvidenceSource; claims: EvidenceClaim[]; cited: string | undefined }) {
  const quotes = claims.flatMap(c =>
    c.links.filter(l => l.sourceId === source.sourceId && (l.verdict === "supported" || l.verdict === "partially_supported"))
      .map(l => ({ claim: c, link: l })));
  return (
    <li className="source-item" id={anchor(source.sourceId)}>
      <span className="source-id" aria-hidden="true">{source.sourceId}</span>
      <div className="source-body">
        <a href={source.url} target="_blank" rel="noopener noreferrer nofollow" className="source-title">
          {source.title}<span className="visually-hidden"> (opens in a new tab)</span>
        </a>
        <p className="source-meta">
          <span>{source.publisher ?? source.domain}</span>
          <span>{source.publishedAt ? `Published ${formatDate(source.publishedAt.slice(0, 10))}` : "Publication date unknown"}</span>
          <span>Read {formatDate(source.retrievedAt)}</span>
        </p>
        {cited && <p className="source-cited"><strong>Cited for:</strong> {cited}</p>}
        {quotes.map(({ claim, link }) =>
          <figure key={`${claim.claimId}-${link.passageId}`} className="quote">
            <blockquote>&ldquo;{link.quote}&rdquo;</blockquote>
            <figcaption>
              <span className="quote-claim">{link.relation === "contradicts" ? "Contradicts" : "Supports"} claim {claim.claimId}: {claim.text}</span>
              <span className="row">
                <Badge tone={VERDICT[link.verdict].tone}>{VERDICT[link.verdict].label}</Badge>
                {claim.freshness === "stale" && <Badge tone="warning">Stale source</Badge>}
                {claim.contradicted && <Badge tone="warning">Sources disagree</Badge>}
              </span>
            </figcaption>
          </figure>)}
      </div>
    </li>
  );
}

function EvidenceSection({ brief, evidence }: { brief: DecisionBrief; evidence: RunEvidence }) {
  const cited = new Map(brief.citations.map(c => [c.source_id, c.supports]));
  const citedSources = evidence.sources.filter(s => cited.has(s.sourceId));
  const otherSources = evidence.sources.filter(s => !cited.has(s.sourceId));
  const rejected = evidence.claims.filter(c => c.status === "unsupported" || c.status === "invalid");
  const verified = evidence.claims.filter(c => c.status === "verified" || c.status === "partial");
  return (
    <section className="brief-section" id="brief-sources" aria-labelledby="sources-title">
      <h2 id="sources-title">Sources and verification</h2>
      <div className="verify-summary">
        <div><strong>{evidence.sources.length}</strong><span>source{evidence.sources.length === 1 ? "" : "s"} read</span></div>
        <div><strong>{verified.length}</strong><span>claim{verified.length === 1 ? "" : "s"} checked against a quote</span></div>
        <div><strong>{rejected.length}</strong><span>claim{rejected.length === 1 ? "" : "s"} failed the check</span></div>
      </div>
      <p className="muted">Each verified claim is matched to a quote copied from the source. Open the source to read it in context.</p>
      {citedSources.length > 0
        ? <ol className="source-list">{citedSources.map(s => <SourceItem key={s.sourceId} source={s} claims={evidence.claims} cited={cited.get(s.sourceId)} />)}</ol>
        : <p className="muted">The brief does not cite any of the sources it read.</p>}
      {otherSources.length > 0 && <details className="disclosure">
        <summary>Read but not cited ({otherSources.length})</summary>
        <ol className="source-list">{otherSources.map(s => <SourceItem key={s.sourceId} source={s} claims={evidence.claims} cited={undefined} />)}</ol>
      </details>}
      {rejected.length > 0 && <details className="disclosure">
        <summary>Claims that failed verification ({rejected.length})</summary>
        <ul className="plain-list">{rejected.map(c =>
          <li key={c.claimId}><Badge tone="danger">{c.status === "invalid" ? "Quote not in source" : "Not supported"}</Badge> <span>{c.claimId}: {c.text}</span></li>)}</ul>
      </details>}
    </section>
  );
}

const SECTIONS: [string, string][] = [
  ["brief-decision", "The decision"], ["brief-assumptions", "Key assumptions"], ["brief-evidence", "Evidence"],
  ["brief-alternatives", "Alternatives"], ["brief-tradeoffs", "Trade-offs"], ["brief-change", "What would change it"],
  ["brief-next", "Next steps"], ["brief-limits", "Limitations"]
];

export function DecisionBriefView({ brief, evidence, remembered, projectId }:
  { brief: DecisionBrief; evidence?: RunEvidence; remembered?: RememberedContext[]; projectId?: string }) {
  const known = new Set((evidence?.sources ?? []).map(s => s.sourceId));
  const hasSources = !!evidence && evidence.sources.length > 0;
  const contents = [...SECTIONS, ...(hasSources ? [["brief-sources", "Sources"] as [string, string]] : [])];
  return (
    <article className="brief-doc" aria-labelledby="brief-title">
      <aside className="brief-toc" aria-label="On this brief">
        <p className="eyebrow">On this brief</p>
        <ol>{contents.map(([id, label]) => <li key={id}><a href={`#${id}`}>{label}</a></li>)}</ol>
      </aside>

      <div className="brief-main">
        <header className="brief-recommendation">
          <div className="row">
            <p className="eyebrow">Recommendation</p>
            <Badge tone={brief.confidence.level === "high" ? "success" : brief.confidence.level === "medium" ? "neutral" : "warning"}>
              Confidence: {brief.confidence.level}
            </Badge>
          </div>
          <h2 id="brief-title" className="display">{brief.recommendation.summary}</h2>
          <p className="brief-rationale">{brief.recommendation.rationale}</p>
          <div className="brief-confidence"><strong>Why this confidence</strong><p>{brief.confidence.explanation}</p></div>
        </header>

        <section className="brief-section" id="brief-decision" aria-labelledby="decision-title">
          <h2 id="decision-title">The decision</h2>
          <p className="brief-question">{brief.decision_question}</p>
          <p><strong>Scope:</strong> {brief.scope}</p>
        </section>

        <section className="brief-section" id="brief-assumptions" aria-labelledby="assumptions-title">
          <h2 id="assumptions-title">Key assumptions</h2>
          {brief.key_assumptions.length ? <ul className="point-list">{brief.key_assumptions.map((a, i) =>
            <li key={i}><span className="row"><Label label={a.label} /><span className="memory-meta">Confidence {a.confidence}</span></span><p>{a.statement}</p></li>)}</ul> : <None />}
        </section>

        <section className="brief-section" id="brief-evidence" aria-labelledby="evidence-title">
          <h2 id="evidence-title">Evidence</h2>
          <p className="muted small">Labels are the model&rsquo;s own assessment of each point. Only points linked to a source have been checked, under Sources and verification.</p>
          <div className="evidence-columns">
            <div>
              <h3 className="subhead">For the recommendation</h3>
              {brief.supporting_evidence.length ? <ul className="point-list">{brief.supporting_evidence.map((e, i) =>
                <li key={i}><span className="row"><Label label={e.label} /><SourceRefs ids={e.source_ids} known={known} /></span><p>{e.point}</p></li>)}</ul> : <None />}
            </div>
            <div>
              <h3 className="subhead">Against it</h3>
              {brief.counterevidence.length ? <ul className="point-list">{brief.counterevidence.map((e, i) =>
                <li key={i}><span className="row"><Label label={e.label} /><SourceRefs ids={e.source_ids} known={known} /></span><p>{e.point}</p></li>)}</ul> : <None />}
            </div>
          </div>
          <div className="callout callout-objection"><strong>Strongest objection</strong><p>{brief.strongest_objection}</p></div>
        </section>

        <section className="brief-section" id="brief-alternatives" aria-labelledby="alternatives-title">
          <h2 id="alternatives-title">Alternatives considered</h2>
          <dl className="term-list">{brief.alternatives.map((a, i) => <div key={i}><dt>{a.option}</dt><dd>Why not now: {a.why_not_now}</dd></div>)}</dl>
        </section>

        <section className="brief-section" id="brief-tradeoffs" aria-labelledby="tradeoffs-title">
          <h2 id="tradeoffs-title">Criteria and trade-offs</h2>
          <dl className="term-list">{brief.criteria_and_tradeoffs.map((c, i) => <div key={i}><dt>{c.criterion}</dt><dd>{c.tradeoff}</dd></div>)}</dl>
        </section>

        <section className="brief-section" id="brief-change" aria-labelledby="change-title">
          <h2 id="change-title">What would change this recommendation</h2>
          <ul className="check-list">{brief.what_would_change.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </section>

        <section className="brief-section" id="brief-next" aria-labelledby="next-title">
          <h2 id="next-title">Recommended next steps</h2>
          <ol className="next-list">{brief.next_actions.map((a, i) =>
            <li key={i}><p className="next-action">{a.action}</p><p className="muted">Success looks like: {a.success_signal}</p>
              {a.reversible && <Badge tone="success">Reversible</Badge>}</li>)}</ol>
        </section>

        <section className="brief-section" id="brief-limits" aria-labelledby="limits-title">
          <h2 id="limits-title">Limitations</h2>
          <ul className="plain-list">{(brief.limitations.length ? brief.limitations : ["None stated by the model; treat this as unverified analysis."]).map((l, i) => <li key={i}>{l}</li>)}</ul>
          {brief.citations.length === 0 && <p className="muted">No sources are cited in this brief.</p>}
        </section>

        {brief.proposed_memory_updates.length > 0 && (
          <section className="brief-section" aria-labelledby="proposed-title">
            <h2 id="proposed-title">Proposed for project memory</h2>
            <p className="muted">Not saved until you approve them{projectId ? <> in <Link href={`/projects/${projectId}?tab=memory`}>Memory</Link></> : " in Memory"}.</p>
            <ul className="plain-list">{brief.proposed_memory_updates.map((m, i) => <li key={i}><span className="label-tag label-hypothesis">{m.kind.replace("_", " ")}</span> {m.statement}</li>)}</ul>
          </section>
        )}

        {hasSources && <EvidenceSection brief={brief} evidence={evidence!} />}

        {remembered && remembered.length > 0 && (
          <details className="disclosure brief-remembered">
            <summary>Project memory this run was given ({remembered.length})</summary>
            <ul className="plain-list">{remembered.map(i =>
              <li key={i.ref}><b className="mono">{i.ref}</b> <span className="label-tag">{i.kind.replace("_", " ")}</span> {i.content} <span className="memory-meta">(recorded {formatDate(i.observedAt)})</span></li>)}</ul>
          </details>
        )}
      </div>
    </article>
  );
}

/** The deterministic demo output: a fixed template, labelled as such, never presented as a brief. */
export function ScaffoldView({ result }: { result: ReasoningResult }) {
  return (
    <section className="scaffold" aria-labelledby="scaffold-title">
      <div className="notice notice-warning" role="note"><div className="notice-body">
        <strong>Starter structure, not a decision brief.</strong> This deployment has no AI model configured, so Echiche produced a fixed
        template showing how to think the question through. It has not analysed your situation or researched anything.
      </div></div>
      <h2 id="scaffold-title" className="card-title">{result.summary}</h2>
      <ol className="scaffold-steps">{result.stages.map(stage =>
        <li key={stage.stage} className="card"><h3>{stage.title}</h3><p>{stage.content}</p></li>)}</ol>
      <p className="muted small"><strong>Limitation:</strong> {result.caveat}</p>
    </section>
  );
}
