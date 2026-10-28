"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import type { Decision, Memory, MemoryKind } from "@/lib/domain/types";

const KINDS: MemoryKind[] = ["goal", "constraint", "assumption", "decision", "open_question", "fact"];
const KIND_LABEL: Record<MemoryKind, string> = {
  goal: "Goal", constraint: "Constraint", assumption: "Assumption", decision: "Decision", open_question: "Open question", fact: "Fact"
};
const RESULT_LABEL: Record<string, string> = {
  as_expected: "As expected", better: "Better than expected", worse: "Worse than expected", mixed: "Mixed", too_early: "Too early to tell"
};
const day = (iso: string) => iso.slice(0, 10);

type Api = <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;

/** fetch wrapper for the journal: JSON in and out; a 401 means the session ended. */
const call: Api = async (path, init) => {
  const response = await fetch(path, {
    method: init?.method ?? "GET",
    cache: "no-store",
    headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined
  });
  if (response.status === 401) {
    window.location.assign("/login");
    throw new Error("Your session has ended. Please sign in again.");
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? "That action failed");
  return body.data;
};

export function Proposal({ memory, onDone }: { memory: Memory; onDone: (message: string) => void }) {
  const [content, setContent] = useState(memory.content);
  const [kind, setKind] = useState<MemoryKind>(memory.kind);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  async function run(action: "approve" | "reject") {
    setBusy(true);
    try {
      if (action === "approve") {
        await call(`/api/memories/${memory.id}/approve`, {
          method: "POST",
          body: { content: content.trim(), kind, ...(memory.sensitivity === "sensitive" ? { confirmSensitive: confirm } : {}) }
        });
        onDone("Saved to project memory.");
      } else {
        await call(`/api/memories/${memory.id}/reject`, { method: "POST" });
        onDone("Proposal rejected; it will not be used.");
      }
    } catch (e) { onDone(e instanceof Error ? e.message : "That action failed"); }
    finally { setBusy(false); }
  }
  return (
    <li className="memory-item proposal">
      <div className="memory-row">
        <select value={kind} onChange={e => setKind(e.target.value as MemoryKind)} aria-label="Kind">
          {KINDS.map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
        <small>Proposed by the run on {day(memory.observedAt)}</small>
      </div>
      <textarea value={content} onChange={e => setContent(e.target.value)} maxLength={500} rows={2} aria-label="Proposed memory" />
      {memory.sensitivity === "sensitive" && (
        <label className="sensitive">
          <input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)} />
          This may contain sensitive personal information. Save it anyway.
        </label>
      )}
      <div className="memory-actions">
        <button type="button" disabled={busy || !content.trim() || (memory.sensitivity === "sensitive" && !confirm)} onClick={() => run("approve")}>
          {content.trim() !== memory.content || kind !== memory.kind ? "Save edited" : "Approve"}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={() => run("reject")}>Reject</button>
      </div>
    </li>
  );
}

export function Remembered({ memory, onDone }: { memory: Memory; onDone: (message: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(memory.content);
  const [history, setHistory] = useState<Memory[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await call(`/api/memories/${memory.id}`, { method: "PATCH", body: { content: content.trim() } });
      setEditing(false);
      onDone("Corrected. The previous version is kept in its history.");
    } catch (e) { onDone(e instanceof Error ? e.message : "Correction failed"); }
    finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true);
    try {
      await call(`/api/memories/${memory.id}`, { method: "DELETE" });
      onDone("Deleted, including all earlier versions.");
    } catch (e) { onDone(e instanceof Error ? e.message : "Delete failed"); }
    finally { setBusy(false); }
  }
  const origin = memory.origin === "user" ? "added by you" : memory.edited ? "proposed by a run, edited by you" : "proposed by a run, approved by you";
  return (
    <li className="memory-item">
      <div className="memory-row">
        <span className="kind">{KIND_LABEL[memory.kind]}</span>
        <small>Remembered since {day(memory.validFrom ?? memory.observedAt)} · {origin}{memory.version > 1 ? ` · version ${memory.version}` : ""}</small>
      </div>
      {editing
        ? <textarea value={content} onChange={e => setContent(e.target.value)} maxLength={500} rows={2} aria-label="Corrected memory" />
        : <p>{memory.content}</p>}
      <div className="memory-actions">
        {editing
          ? <><button type="button" disabled={busy || !content.trim() || content.trim() === memory.content} onClick={save}>Save correction</button>
              <button type="button" className="secondary" onClick={() => { setEditing(false); setContent(memory.content); }}>Cancel</button></>
          : <button type="button" className="secondary" onClick={() => setEditing(true)}>Correct</button>}
        {memory.version > 1 && <button type="button" className="secondary" onClick={async () =>
          setHistory(history ? null : await call<Memory[]>(`/api/memories/${memory.id}/history`))}>{history ? "Hide history" : "History"}</button>}
        {confirmDelete
          ? <button type="button" className="danger" disabled={busy} onClick={remove}>Delete permanently</button>
          : <button type="button" className="secondary" onClick={() => setConfirmDelete(true)}>Delete</button>}
      </div>
      {history && <ol className="history">{history.map(h =>
        <li key={h.id}><b>v{h.version}</b> {h.content} <small>({h.status}{h.validTo ? ` until ${day(h.validTo)}` : ""})</small></li>)}</ol>}
    </li>
  );
}

export function DecisionJournal({ decisions, onDone }: { decisions: Decision[]; onDone: (message: string) => void }) {
  const current = decisions.find(d => d.status === "active");
  const earlier = decisions.filter(d => d.status !== "active");
  const [revising, setRevising] = useState(false);
  const [choice, setChoice] = useState("");
  const [rationale, setRationale] = useState("");
  const [outcome, setOutcome] = useState({ result: "as_expected", observedOutcome: "", observedOn: new Date().toISOString().slice(0, 10) });
  if (!current) return <p className="empty-note">No decision recorded yet. Accepting a decision brief records it here.</p>;
  async function revise(event: FormEvent) {
    event.preventDefault();
    try {
      await call(`/api/decisions/${current!.id}/revise`, { method: "POST", body: { choice, rationale } });
      setRevising(false); setChoice(""); setRationale("");
      onDone("Decision revised. The earlier version and its rationale stay in the journal.");
    } catch (e) { onDone(e instanceof Error ? e.message : "Revision failed"); }
  }
  async function addOutcome(event: FormEvent) {
    event.preventDefault();
    try {
      await call(`/api/decisions/${current!.id}/outcomes`, { method: "POST", body: outcome });
      setOutcome(o => ({ ...o, observedOutcome: "" }));
      onDone("Outcome recorded.");
    } catch (e) { onDone(e instanceof Error ? e.message : "Could not record the outcome"); }
  }
  return (
    <div className="decision">
      <p className="decision-choice"><b>{current.choice}</b></p>
      <p>{current.rationale}</p>
      <small>Version {current.version} · {current.origin === "accepted_brief" ? "from an accepted brief" : "revised by you"} · {day(current.createdAt)}
        {current.confidence ? ` · confidence ${current.confidence}` : ""}</small>
      {current.reviewTriggers.length > 0 && <p className="triggers">Revisit if: {current.reviewTriggers.join("; ")}</p>}
      {current.outcomes.length > 0 && <ul className="outcomes">{current.outcomes.map(o =>
        <li key={o.id}><b>{RESULT_LABEL[o.result]}</b> ({o.observedOn}): {o.observedOutcome}</li>)}</ul>}
      <form className="inline-form" onSubmit={addOutcome}>
        <select value={outcome.result} onChange={e => setOutcome(o => ({ ...o, result: e.target.value }))} aria-label="Result">
          {Object.entries(RESULT_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <input type="date" value={outcome.observedOn} onChange={e => setOutcome(o => ({ ...o, observedOn: e.target.value }))} aria-label="Observed on" />
        <input value={outcome.observedOutcome} onChange={e => setOutcome(o => ({ ...o, observedOutcome: e.target.value }))} maxLength={2000} placeholder="What happened?" aria-label="What happened" />
        <button disabled={!outcome.observedOutcome.trim()}>Record outcome</button>
      </form>
      {revising
        ? <form className="form-stack revise" onSubmit={revise}>
            <input value={choice} onChange={e => setChoice(e.target.value)} maxLength={1000} placeholder="New decision" required />
            <textarea value={rationale} onChange={e => setRationale(e.target.value)} maxLength={4000} rows={3} placeholder="Why it changed" required />
            <div className="memory-actions"><button disabled={!choice.trim() || !rationale.trim()}>Save new version</button>
              <button type="button" className="secondary" onClick={() => setRevising(false)}>Cancel</button></div>
          </form>
        : <button type="button" className="secondary" onClick={() => setRevising(true)}>Revise decision</button>}
      {earlier.length > 0 && <details><summary>Earlier versions ({earlier.length})</summary><ol className="history">{earlier.map(d =>
        <li key={d.id}><b>v{d.version}</b> {d.choice} <small>({day(d.createdAt)}{d.supersededAt ? `, superseded ${day(d.supersededAt)}` : ""})</small>
          <p>{d.rationale}</p></li>)}</ol></details>}
    </div>
  );
}

/** Project memory and decision journal (M6). Nothing a run proposes is kept until approved here. */
export function Journal({ projectId, refreshKey, onDeleted }: { projectId: string; refreshKey: string; onDeleted: () => void }) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [note, setNote] = useState("");
  const [kind, setKind] = useState<MemoryKind>("goal");
  const [content, setContent] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    const [proposed, active, journal] = await Promise.all([
      call<Memory[]>(`/api/projects/${projectId}/memories?status=proposed`),
      call<Memory[]>(`/api/projects/${projectId}/memories?status=active`),
      call<Decision[]>(`/api/projects/${projectId}/decisions`)
    ]);
    setMemories([...proposed, ...active]);
    setDecisions(journal);
  }, [projectId]);

  useEffect(() => { load().catch(e => setNote(e instanceof Error ? e.message : "Could not load memory")); }, [load, refreshKey]);

  const done = (message: string) => { setNote(message); load().catch(() => {}); };
  const proposals = memories.filter(m => m.status === "proposed");
  const remembered = memories.filter(m => m.status === "active");

  async function add(event: FormEvent) {
    event.preventDefault();
    try {
      await call(`/api/projects/${projectId}/memories`, { method: "POST", body: { kind, content: content.trim() } });
      setContent("");
      done("Added to project memory.");
    } catch (e) { setNote(e instanceof Error ? e.message : "Could not add the memory"); }
  }
  async function deleteProject() {
    try {
      await call(`/api/projects/${projectId}`, { method: "DELETE" });
      onDeleted();
    } catch (e) { setNote(e instanceof Error ? e.message : "Could not delete the project"); }
  }

  return (
    <section className="panel journal" aria-live="polite">
      <div className="section-heading"><span className="step">04</span><div><h2>Memory and decisions</h2>
        <p>What Echiche remembers about this project. New runs see these items, labelled as remembered.</p></div></div>
      {note && <div className="notice" role="status">{note}</div>}
      {proposals.length > 0 && <>
        <h3>Proposed by runs ({proposals.length}) · not saved until you approve</h3>
        <ul className="memory-list">{proposals.map(m => <Proposal key={m.id} memory={m} onDone={done} />)}</ul>
      </>}
      <h3>Remembered ({remembered.length})</h3>
      {remembered.length === 0
        ? <p className="empty-note">Nothing remembered yet. Approve proposals or add your own below.</p>
        : <ul className="memory-list">{remembered.map(m => <Remembered key={m.id} memory={m} onDone={done} />)}</ul>}
      <form className="inline-form" onSubmit={add}>
        <select value={kind} onChange={e => setKind(e.target.value as MemoryKind)} aria-label="Kind">
          {KINDS.map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
        <input value={content} onChange={e => setContent(e.target.value)} maxLength={500} placeholder="Add something Echiche should remember" aria-label="New memory" />
        <button disabled={!content.trim()}>Add</button>
      </form>
      <h3>Decision journal</h3>
      <DecisionJournal decisions={decisions} onDone={done} />
      <div className="project-data">
        <a href={`/api/projects/${projectId}/export`} download>Export project data (JSON)</a>
        {confirmDelete
          ? <><button type="button" className="danger" onClick={deleteProject}>Permanently delete this project and all its data</button>
              <button type="button" className="secondary" onClick={() => setConfirmDelete(false)}>Keep it</button></>
          : <button type="button" className="secondary" onClick={() => setConfirmDelete(true)}>Delete project…</button>}
      </div>
    </section>
  );
}
