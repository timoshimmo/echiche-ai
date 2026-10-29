"use client";
// Project memory and decision journal (M6). Nothing a run proposes is kept until the user approves it,
// corrections keep earlier versions, and revising a decision never overwrites the original.

import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { Decision, Memory, MemoryKind } from "@/lib/domain/types";
import { api, errorMessage } from "./lib/api";
import { formatDate } from "./lib/run-display";
import { Badge, ConfirmDialog, EmptyState, Field, Notice, Skeleton } from "./ui/primitives";

const KINDS: MemoryKind[] = ["goal", "constraint", "assumption", "decision", "open_question", "fact"];
export const KIND_LABEL: Record<MemoryKind, string> = {
  goal: "Goal", constraint: "Constraint", assumption: "Assumption", decision: "Decision", open_question: "Open question", fact: "Fact"
};
/** Assumptions and open questions are explicitly not established; their tag is dashed (design system). */
const KIND_CLASS: Record<MemoryKind, string> = {
  goal: "label-inference", constraint: "label-inference", assumption: "label-hypothesis", decision: "label-inference",
  open_question: "label-unknown", fact: "label-fact"
};
const RESULT_LABEL: Record<string, string> = {
  as_expected: "As expected", better: "Better than expected", worse: "Worse than expected", mixed: "Mixed", too_early: "Too early to tell"
};
const RESULT_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  as_expected: "success", better: "success", worse: "danger", mixed: "warning", too_early: "neutral"
};
const day = (iso: string) => formatDate(iso);

function KindTag({ kind }: { kind: MemoryKind }) {
  return <span className={`label-tag ${KIND_CLASS[kind]}`}>{KIND_LABEL[kind]}</span>;
}

function SourceRun({ projectId, runId, children }: { projectId: string; runId: string | null; children: string }) {
  return runId ? <Link href={`/projects/${projectId}/runs/${runId}`}>{children}</Link> : <>{children}</>;
}

export function Proposal({ memory, projectId, onDone }: { memory: Memory; projectId: string; onDone: (message: string, tone?: "error") => void }) {
  const [content, setContent] = useState(memory.content);
  const [kind, setKind] = useState<MemoryKind>(memory.kind);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const edited = content.trim() !== memory.content || kind !== memory.kind;
  async function run(action: "approve" | "reject") {
    setBusy(true);
    try {
      if (action === "approve") {
        await api(`/api/memories/${memory.id}/approve`, {
          method: "POST",
          body: { content: content.trim(), kind, ...(memory.sensitivity === "sensitive" ? { confirmSensitive: confirm } : {}) }
        });
        onDone("Saved to project memory.");
      } else {
        await api(`/api/memories/${memory.id}/reject`, { method: "POST" });
        onDone("Proposal rejected. It will not be used.");
      }
    } catch (e) { onDone(errorMessage(e, "That action failed."), "error"); setBusy(false); }
  }
  return (
    <li className="memory-card proposal">
      <div className="memory-card-head">
        <Badge tone="warning">Proposed · not saved</Badge>
        <span className="memory-meta">Suggested by <SourceRun projectId={projectId} runId={memory.sourceRunId}>a run</SourceRun> on {day(memory.observedAt)}</span>
      </div>
      <div className="proposal-fields">
        <label className="visually-hidden" htmlFor={`kind-${memory.id}`}>Kind</label>
        <select id={`kind-${memory.id}`} className="select select-sm" value={kind} onChange={e => setKind(e.target.value as MemoryKind)}>
          {KINDS.map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
        <label className="visually-hidden" htmlFor={`content-${memory.id}`}>Proposed memory (you can edit it before saving)</label>
        <textarea id={`content-${memory.id}`} className="textarea" value={content} onChange={e => setContent(e.target.value)} maxLength={500} rows={2} />
      </div>
      {memory.sensitivity === "sensitive" && (
        <label className="checkbox sensitive">
          <input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)} />
          This may contain sensitive personal information. Save it anyway.
        </label>
      )}
      <div className="row">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !content.trim() || (memory.sensitivity === "sensitive" && !confirm)} onClick={() => run("approve")}>
          {edited ? "Save edited version" : "Approve"}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => run("reject")}>Reject</button>
      </div>
    </li>
  );
}

export function Remembered({ memory, projectId, onDone }: { memory: Memory; projectId: string; onDone: (message: string, tone?: "error") => void }) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(memory.content);
  const [history, setHistory] = useState<Memory[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await api(`/api/memories/${memory.id}`, { method: "PATCH", body: { content: content.trim() } });
      setEditing(false);
      onDone("Corrected. The previous version is kept in its history.");
    } catch (e) { onDone(errorMessage(e, "Correction failed."), "error"); }
    finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true);
    try {
      await api(`/api/memories/${memory.id}`, { method: "DELETE" });
      setConfirmDelete(false);
      onDone("Deleted, including all earlier versions.");
    } catch (e) { onDone(errorMessage(e, "Delete failed."), "error"); setBusy(false); }
  }
  async function toggleHistory() {
    if (history) { setHistory(null); return; }
    try { setHistory(await api<Memory[]>(`/api/memories/${memory.id}/history`)); }
    catch (e) { onDone(errorMessage(e, "Could not load the history."), "error"); }
  }
  const origin = memory.origin === "user" ? (memory.version > 1 ? "corrected by you" : "added by you")
    : memory.edited ? "proposed by a run, edited and approved by you" : "proposed by a run, approved by you";
  return (
    <li className="memory-card">
      <div className="memory-card-head">
        <KindTag kind={memory.kind} />
        {memory.version > 1 && <Badge plain>Version {memory.version}</Badge>}
      </div>
      {editing
        ? <><label className="visually-hidden" htmlFor={`fix-${memory.id}`}>Corrected memory</label>
            <textarea id={`fix-${memory.id}`} className="textarea" value={content} onChange={e => setContent(e.target.value)} maxLength={500} rows={2} /></>
        : <p className="memory-content">{memory.content}</p>}
      <p className="memory-meta">
        Remembered since {day(memory.validFrom ?? memory.observedAt)} · {memory.sourceRunId && memory.origin === "model_proposal"
          ? <SourceRun projectId={projectId} runId={memory.sourceRunId}>{origin}</SourceRun> : origin}
      </p>
      <div className="row">
        {editing
          ? <><button type="button" className="btn btn-primary btn-sm" disabled={busy || !content.trim() || content.trim() === memory.content} onClick={save}>Save correction</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setEditing(false); setContent(memory.content); }}>Cancel</button></>
          : <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}>Correct</button>}
        {memory.version > 1 && <button type="button" className="btn btn-ghost btn-sm" aria-expanded={!!history} onClick={toggleHistory}>{history ? "Hide history" : "Show history"}</button>}
        <button type="button" className="btn btn-ghost btn-sm danger-text" onClick={() => setConfirmDelete(true)}>Delete</button>
      </div>
      {history && <ol className="version-list" aria-label="Version history">{history.map(h =>
        <li key={h.id} className={h.id === memory.id ? "current" : ""}>
          <span className="version-n">v{h.version}</span>
          <div><p>{h.content}</p><small>{h.status === "active" ? "Current" : `Replaced${h.validTo ? ` on ${day(h.validTo)}` : ""}`} · recorded {day(h.createdAt)}</small></div>
        </li>)}</ol>}
      <ConfirmDialog open={confirmDelete} title="Delete this memory?" confirmLabel="Delete permanently" danger busy={busy}
        onConfirm={remove} onCancel={() => setConfirmDelete(false)}>
        <p>Echiche will stop using it in new runs. {memory.version > 1 ? `All ${memory.version} versions are deleted` : "It is deleted"} and cannot be recovered.</p>
        <blockquote className="dialog-quote">{memory.content}</blockquote>
      </ConfirmDialog>
    </li>
  );
}

/** Memory tab: proposals to review, what is remembered (searchable), and adding your own. */
export function MemoryPanel({ projectId, onChange }: { projectId: string; onChange?: () => void }) {
  const [proposals, setProposals] = useState<Memory[] | null>(null);
  const [remembered, setRemembered] = useState<Memory[] | null>(null);
  const [note, setNote] = useState<{ text: string; tone?: "error" } | null>(null);
  const [kind, setKind] = useState<MemoryKind>("goal");
  const [content, setContent] = useState("");
  const [query, setQuery] = useState("");
  const [filterKind, setFilterKind] = useState<MemoryKind | "">("");

  const load = useCallback(async () => {
    const params = new URLSearchParams({ status: "active" });
    if (query.trim()) params.set("q", query.trim());
    if (filterKind) params.set("kind", filterKind);
    const [proposed, active] = await Promise.all([
      api<Memory[]>(`/api/projects/${projectId}/memories?status=proposed`),
      api<Memory[]>(`/api/projects/${projectId}/memories?${params}`)
    ]);
    setProposals(proposed);
    setRemembered(active);
  }, [projectId, query, filterKind]);

  useEffect(() => {
    const timer = setTimeout(() => { load().catch(e => setNote({ text: errorMessage(e, "Could not load memory."), tone: "error" })); }, query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, query]);

  const done = (text: string, tone?: "error") => { setNote({ text, tone }); load().catch(() => {}); onChange?.(); };

  async function add(event: FormEvent) {
    event.preventDefault();
    try {
      await api(`/api/projects/${projectId}/memories`, { method: "POST", body: { kind, content: content.trim() } });
      setContent("");
      done("Added to project memory.");
    } catch (e) { setNote({ text: errorMessage(e, "Could not add the memory."), tone: "error" }); }
  }

  const filtering = !!query.trim() || !!filterKind;
  return (
    <div className="stack">
      <p className="panel-intro">What Echiche remembers about this project. New runs are given these items and show which ones they used. You decide what is kept: proposals are not used until you approve them.</p>
      {note && <Notice tone={note.tone ?? "success"} onDismiss={() => setNote(null)}>{note.text}</Notice>}

      {proposals === null || remembered === null ? <Skeleton lines={3} /> : <>
        {proposals.length > 0 && (
          <section aria-labelledby="proposals-title" className="stack-sm">
            <h3 id="proposals-title" className="subhead">To review ({proposals.length})</h3>
            <ul className="memory-list">{proposals.map(m => <Proposal key={m.id} memory={m} projectId={projectId} onDone={done} />)}</ul>
          </section>
        )}

        <section aria-labelledby="remembered-title" className="stack-sm">
          <div className="subhead-row">
            <h3 id="remembered-title" className="subhead">Remembered{filtering ? " (filtered)" : ""} ({remembered.length})</h3>
            <div className="memory-filters" role="search">
              <label className="visually-hidden" htmlFor="memory-search">Search memory</label>
              <input id="memory-search" className="input input-sm" type="search" value={query} onChange={e => setQuery(e.target.value)} maxLength={200} placeholder="Search memory" />
              <label className="visually-hidden" htmlFor="memory-kind">Filter by kind</label>
              <select id="memory-kind" className="select select-sm" value={filterKind} onChange={e => setFilterKind(e.target.value as MemoryKind | "")}>
                <option value="">All kinds</option>
                {KINDS.map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </select>
            </div>
          </div>
          {remembered.length === 0
            ? (filtering
                ? <p className="muted">Nothing matches. <button type="button" className="link-button" onClick={() => { setQuery(""); setFilterKind(""); }}>Clear the search</button></p>
                : <EmptyState title="Nothing remembered yet">Approve what runs propose, or add goals, constraints and assumptions yourself below.</EmptyState>)
            : <ul className="memory-list">{remembered.map(m => <Remembered key={m.id} memory={m} projectId={projectId} onDone={done} />)}</ul>}
        </section>

        <form className="card add-memory" onSubmit={add} aria-labelledby="add-title">
          <h3 id="add-title" className="subhead">Add something to remember</h3>
          <div className="add-memory-fields">
            <Field label="Kind">{props => (
              <select {...props} className="select" value={kind} onChange={e => setKind(e.target.value as MemoryKind)}>
                {KINDS.map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </select>)}</Field>
            <Field label="What should Echiche remember?" hint="Up to 500 characters. Saved as added by you.">{props => (
              <input {...props} className="input" value={content} onChange={e => setContent(e.target.value)} maxLength={500} placeholder="For example: We will not raise prices before Q3." />)}</Field>
          </div>
          <div><button className="btn btn-primary btn-sm" disabled={!content.trim()}>Add to memory</button></div>
        </form>
      </>}
    </div>
  );
}

/** Decision journal tab: the current decision, outcomes, revisions and every earlier version. */
export function JournalPanel({ projectId }: { projectId: string }) {
  const [decisions, setDecisions] = useState<Decision[] | null>(null);
  const [note, setNote] = useState<{ text: string; tone?: "error" } | null>(null);
  const load = useCallback(async () => setDecisions(await api<Decision[]>(`/api/projects/${projectId}/decisions`)), [projectId]);
  useEffect(() => { load().catch(e => setNote({ text: errorMessage(e, "Could not load the journal."), tone: "error" })); }, [load]);
  const done = (text: string, tone?: "error") => { setNote({ text, tone }); load().catch(() => {}); };
  return (
    <div className="stack">
      <p className="panel-intro">The decisions you have recorded for this project. Revising a decision adds a new version; the original and its reasoning stay here.</p>
      {note && <Notice tone={note.tone ?? "success"} onDismiss={() => setNote(null)}>{note.text}</Notice>}
      {decisions === null ? <Skeleton lines={3} /> : <DecisionJournal decisions={decisions} projectId={projectId} onDone={done} />}
    </div>
  );
}

export function DecisionJournal({ decisions, projectId, onDone }: { decisions: Decision[]; projectId: string; onDone: (message: string, tone?: "error") => void }) {
  const current = decisions.find(d => d.status === "active");
  const earlier = decisions.filter(d => d.status !== "active").sort((a, b) => b.version - a.version);
  const [revising, setRevising] = useState(false);
  const [choice, setChoice] = useState("");
  const [rationale, setRationale] = useState("");
  const [outcome, setOutcome] = useState({ result: "as_expected", observedOutcome: "", observedOn: new Date().toISOString().slice(0, 10) });
  if (!current) {
    return <EmptyState title="No decision recorded yet">When a brief is ready, accept it on the run page to record the decision here. You can revise it and record outcomes later.</EmptyState>;
  }
  async function revise(event: FormEvent) {
    event.preventDefault();
    try {
      await api(`/api/decisions/${current!.id}/revise`, { method: "POST", body: { choice, rationale } });
      setRevising(false); setChoice(""); setRationale("");
      onDone("Decision revised. The earlier version and its rationale stay in the journal.");
    } catch (e) { onDone(errorMessage(e, "Revision failed."), "error"); }
  }
  async function addOutcome(event: FormEvent) {
    event.preventDefault();
    try {
      await api(`/api/decisions/${current!.id}/outcomes`, { method: "POST", body: outcome });
      setOutcome(o => ({ ...o, observedOutcome: "" }));
      onDone("Outcome recorded.");
    } catch (e) { onDone(errorMessage(e, "Could not record the outcome."), "error"); }
  }
  return (
    <div className="journal-layout">
      <article className="decision-card" aria-labelledby="current-decision">
        <div className="row">
          <Badge tone="ink">Current decision</Badge>
          <span className="memory-meta">Version {current.version} · {current.origin === "accepted_brief"
            ? <SourceRun projectId={projectId} runId={current.sourceRunId}>from an accepted brief</SourceRun> : "revised by you"} · {day(current.createdAt)}
            {current.confidence ? ` · confidence ${current.confidence}` : ""}</span>
        </div>
        <p className="decision-question">{current.question}</p>
        <h3 id="current-decision" className="decision-choice display">{current.choice}</h3>
        <p className="decision-rationale">{current.rationale}</p>

        {current.reviewTriggers.length > 0 && (
          <div className="callout">
            <strong>Revisit this decision if</strong>
            <ul>{current.reviewTriggers.map(t => <li key={t}>{t}</li>)}</ul>
          </div>
        )}

        <section aria-labelledby="outcomes-title" className="stack-sm">
          <h4 id="outcomes-title" className="subhead">Outcomes</h4>
          {current.outcomes.length === 0
            ? <p className="muted">No outcomes recorded yet. Record what happens so future runs and reviews can learn from it.</p>
            : <ul className="outcome-list">{current.outcomes.map(o =>
                <li key={o.id}><Badge tone={RESULT_TONE[o.result]}>{RESULT_LABEL[o.result]}</Badge><span className="memory-meta">{formatDate(o.observedOn)}</span><p>{o.observedOutcome}</p></li>)}</ul>}
          <form className="outcome-form" onSubmit={addOutcome} aria-label="Record an outcome">
            <Field label="Result">{props => (
              <select {...props} className="select" value={outcome.result} onChange={e => setOutcome(o => ({ ...o, result: e.target.value }))}>
                {Object.entries(RESULT_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>)}</Field>
            <Field label="Observed on">{props => (
              <input {...props} className="input" type="date" value={outcome.observedOn} onChange={e => setOutcome(o => ({ ...o, observedOn: e.target.value }))} />)}</Field>
            <Field label="What happened?">{props => (
              <input {...props} className="input" value={outcome.observedOutcome} onChange={e => setOutcome(o => ({ ...o, observedOutcome: e.target.value }))} maxLength={2000} placeholder="For example: Two senior hires signed within six weeks." />)}</Field>
            <div className="outcome-submit"><button className="btn btn-secondary" disabled={!outcome.observedOutcome.trim()}>Record outcome</button></div>
          </form>
        </section>

        {revising
          ? <form className="revise-form stack-sm" onSubmit={revise} aria-label="Revise the decision">
              <h4 className="subhead">Revise the decision</h4>
              <p className="muted">This adds version {current.version + 1}. Version {current.version} and its rationale stay in the history below.</p>
              <Field label="New decision">{props => <input {...props} className="input" value={choice} onChange={e => setChoice(e.target.value)} maxLength={1000} required />}</Field>
              <Field label="Why it changed">{props => <textarea {...props} className="textarea" value={rationale} onChange={e => setRationale(e.target.value)} maxLength={4000} rows={3} required />}</Field>
              <div className="row"><button className="btn btn-primary btn-sm" disabled={!choice.trim() || !rationale.trim()}>Save new version</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRevising(false)}>Cancel</button></div>
            </form>
          : <div><button type="button" className="btn btn-secondary btn-sm" onClick={() => setRevising(true)}>Revise decision</button></div>}
      </article>

      {earlier.length > 0 && (
        <section aria-labelledby="history-title" className="decision-history">
          <h3 id="history-title" className="subhead">Earlier versions ({earlier.length})</h3>
          <ol className="timeline-v">{earlier.map(d =>
            <li key={d.id}>
              <div className="row">
                <Badge plain>{d.version === 1 ? "Original decision" : `Version ${d.version}`}</Badge>
                <span className="memory-meta">{day(d.createdAt)}{d.supersededAt ? ` · replaced ${day(d.supersededAt)}` : ""} · {d.origin === "accepted_brief"
                  ? <SourceRun projectId={projectId} runId={d.sourceRunId}>from an accepted brief</SourceRun> : "revised by you"}</span>
              </div>
              <p className="history-choice">{d.choice}</p>
              <p className="muted">{d.rationale}</p>
              {d.outcomes.length > 0 && <ul className="outcome-list compact">{d.outcomes.map(o =>
                <li key={o.id}><Badge tone={RESULT_TONE[o.result]}>{RESULT_LABEL[o.result]}</Badge><span className="memory-meta">{formatDate(o.observedOn)}</span><p>{o.observedOutcome}</p></li>)}</ul>}
            </li>)}</ol>
        </section>
      )}
    </div>
  );
}
