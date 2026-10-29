"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, Suspense, useCallback, useEffect, useState } from "react";
import type { Memory, Project, ThoughtRun } from "@/lib/domain/types";
import { JournalPanel, MemoryPanel } from "../../../journal";
import { api, ApiError, errorMessage } from "../../../lib/api";
import { DEPTHS, type Depth, formatDate, isSettled } from "../../../lib/run-display";
import { RunRow } from "../../../ui/lists";
import { Badge, ConfirmDialog, EmptyState, Field, Notice, Skeleton, Tabs } from "../../../ui/primitives";

type Tab = "thinking" | "memory" | "journal" | "data";
const TABS: Tab[] = ["thinking", "memory", "journal", "data"];

export default function ProjectPage() {
  return <Suspense fallback={<Skeleton lines={4} />}><ProjectWorkspace /></Suspense>;
}

function ProjectWorkspace() {
  const { projectId } = useParams<{ projectId: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const initialTab = TABS.includes(search.get("tab") as Tab) ? search.get("tab") as Tab : "thinking";
  const [tab, setTab] = useState<Tab>(initialTab);
  const [project, setProject] = useState<Project | null>(null);
  const [runs, setRuns] = useState<ThoughtRun[] | null>(null);
  const [proposalCount, setProposalCount] = useState(0);
  const [error, setError] = useState<{ text: string; missing?: boolean } | null>(null);
  const [note, setNote] = useState(search.get("created") ? "Project created. Ask your first question below." : "");

  const load = useCallback(async () => {
    try {
      const [p, r, proposed] = await Promise.all([
        api<Project>(`/api/projects/${projectId}`),
        api<ThoughtRun[]>(`/api/projects/${projectId}/runs`),
        api<Memory[]>(`/api/projects/${projectId}/memories?status=proposed`)
      ]);
      setProject(p); setRuns(r); setProposalCount(proposed.length); setError(null);
    } catch (e) {
      setError({ text: errorMessage(e, "Could not load this project."), missing: e instanceof ApiError && e.status === 404 });
    }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  function select(next: string) {
    setTab(next as Tab);
    const url = new URL(window.location.href);
    url.searchParams.delete("created");
    if (next === "thinking") url.searchParams.delete("tab"); else url.searchParams.set("tab", next);
    window.history.replaceState(null, "", url);
  }

  if (error?.missing) {
    return <EmptyState title="Project not found" action={<Link href="/projects" className="btn btn-primary">Back to projects</Link>}>
      It may have been deleted, or the link is wrong.</EmptyState>;
  }
  if (error && !project) return <Notice tone="error">{error.text} <button type="button" className="link-button" onClick={() => void load()}>Try again</button></Notice>;
  if (!project || !runs) return <div aria-busy="true"><span className="visually-hidden">Loading project</span><Skeleton lines={5} /></div>;

  return (
    <div>
      <nav aria-label="Breadcrumb" className="breadcrumb"><Link href="/projects">Projects</Link><span aria-hidden="true">/</span><span aria-current="page">{project.title}</span></nav>
      <ProjectHeader project={project} onSaved={p => { setProject(p); setNote("Project updated."); }} />
      {note && <Notice onDismiss={() => setNote("")}>{note}</Notice>}

      <Tabs idPrefix="project" label="Project sections" selected={tab} onSelect={select} tabs={[
        { id: "thinking", label: "Thinking", count: runs.length },
        { id: "memory", label: proposalCount ? `Memory · ${proposalCount} to review` : "Memory" },
        { id: "journal", label: "Decision journal" },
        { id: "data", label: "Data and settings" }
      ]} />
      <div role="tabpanel" id={`project-panel-${tab}`} aria-labelledby={`project-tab-${tab}`} className="tab-panel">
        {tab === "thinking" && <ThinkingPanel project={project} runs={runs} />}
        {tab === "memory" && <MemoryPanel projectId={project.id} onChange={() => void load()} />}
        {tab === "journal" && <JournalPanel projectId={project.id} />}
        {tab === "data" && <DataPanel project={project} onChanged={p => { setProject(p); setNote(p.archivedAt ? "Project archived. It keeps all its data." : "Project restored to your active list."); }}
          onDeleted={() => router.push("/projects?deleted=1")} />}
      </div>
    </div>
  );
}

function ProjectHeader({ project, onSaved }: { project: Project; onSaved: (p: Project) => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(project.title);
  const [statement, setStatement] = useState(project.problemStatement);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const changes = { ...(title.trim() !== project.title ? { title: title.trim() } : {}), ...(statement.trim() !== project.problemStatement ? { problemStatement: statement.trim() } : {}) };
      const updated = Object.keys(changes).length ? await api<Project>(`/api/projects/${project.id}`, { method: "PATCH", body: changes }) : project;
      setEditing(false); onSaved(updated);
    } catch (e) { setError(errorMessage(e, "Could not save the project.")); }
    finally { setBusy(false); }
  }
  if (editing) {
    return (
      <form className="card stack project-edit" onSubmit={save} aria-label="Edit project">
        {error && <Notice tone="error">{error}</Notice>}
        <Field label="Project name">{props => <input {...props} className="input" value={title} onChange={e => setTitle(e.target.value)} minLength={2} maxLength={120} required />}</Field>
        <Field label="What are you trying to decide?" hint="New runs start from this description. Earlier runs keep the question they were given.">{props =>
          <textarea {...props} className="textarea" value={statement} onChange={e => setStatement(e.target.value)} minLength={10} maxLength={5000} rows={4} required />}</Field>
        <div className="row">
          <button className="btn btn-primary btn-sm" disabled={busy || title.trim().length < 2 || statement.trim().length < 10}>Save changes</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setEditing(false); setTitle(project.title); setStatement(project.problemStatement); }}>Cancel</button>
        </div>
      </form>
    );
  }
  return (
    <div className="page-head project-head">
      <div>
        <div className="row">
          <p className="eyebrow">Project</p>
          {project.archivedAt && <Badge>Archived {formatDate(project.archivedAt)}</Badge>}
        </div>
        <h1 className="display">{project.title}</h1>
        <p className="lede">{project.problemStatement}</p>
        <p className="memory-meta">Created {formatDate(project.createdAt)} · updated {formatDate(project.updatedAt)}</p>
      </div>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}>Edit project</button>
    </div>
  );
}

function ThinkingPanel({ project, runs }: { project: Project; runs: ThoughtRun[] }) {
  const router = useRouter();
  const [prompt, setPrompt] = useState(runs.length === 0 ? project.problemStatement : "");
  const [depth, setDepth] = useState<Depth>("auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = runs.find(r => !isSettled(r.status));

  async function start(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const run = await api<ThoughtRun>(`/api/projects/${project.id}/runs`, {
        method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: { prompt: prompt.trim(), depth }
      });
      router.push(`/projects/${project.id}/runs/${run.id}`);
    } catch (e) { setError(errorMessage(e, "Could not start the run.")); setBusy(false); }
  }

  const hint = DEPTHS.find(d => d.value === depth)!.hint;
  return (
    <div className="thinking">
      <section className="card ask" aria-labelledby="ask-title">
        <h2 id="ask-title" className="card-title">Ask Echiche</h2>
        <p className="muted">Each run frames the decision, researches it where useful, challenges it and checks its claims, then writes a brief for you to review.</p>
        {project.archivedAt
          ? <Notice tone="info">This project is archived, so new runs are turned off. Restore it from Data and settings to continue.</Notice>
          : active
            ? <Notice tone="info">A run is in progress. <Link href={`/projects/${project.id}/runs/${active.id}`}>Follow its progress</Link>. You can start another when it finishes.</Notice>
            : null}
        {error && <Notice tone="error">{error}</Notice>}
        <form className="stack" onSubmit={start}>
          <Field label="Your question or decision" hint="10–8,000 characters. Echiche also sees what this project remembers.">{props =>
            <textarea {...props} className="textarea" value={prompt} onChange={e => setPrompt(e.target.value)} minLength={10} maxLength={8000} required rows={5}
              placeholder="What do you need to decide now, and what would help you decide?" />}</Field>
          <Field label="Depth" hint={hint}>{props =>
            <select {...props} className="select" value={depth} onChange={e => setDepth(e.target.value as Depth)}>
              {DEPTHS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>}</Field>
          <div>
            <button className="btn btn-primary" disabled={busy || !!active || !!project.archivedAt || prompt.trim().length < 10}>
              {busy && <span className="spinner" aria-hidden="true" />}{busy ? "Starting…" : "Think it through"} {!busy && <span className="btn-arrow" aria-hidden="true">→</span>}
            </button>
          </div>
        </form>
      </section>

      <section aria-labelledby="history-title" className="run-history">
        <div className="section-title"><h2 id="history-title">Run history</h2>{runs.length >= 50 && <span className="muted">Latest 50</span>}</div>
        {runs.length === 0
          ? <EmptyState title="No runs yet">Your first run will appear here. Every run keeps its brief, evidence and the memory it was given, so you can come back to it.</EmptyState>
          : <ul className="list">{runs.map(r => <RunRow key={r.id} run={r} />)}</ul>}
      </section>
    </div>
  );
}

function DataPanel({ project, onChanged, onDeleted }: { project: Project; onChanged: (p: Project) => void; onDeleted: () => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function archive(archived: boolean) {
    setBusy(true); setError("");
    try { onChanged(await api<Project>(`/api/projects/${project.id}`, { method: "PATCH", body: { archived } })); }
    catch (e) { setError(errorMessage(e, "Could not update the project.")); }
    finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true); setError("");
    try { await api(`/api/projects/${project.id}`, { method: "DELETE" }); onDeleted(); }
    catch (e) { setError(errorMessage(e, "Could not delete the project.")); setBusy(false); setConfirmDelete(false); }
  }
  return (
    <div className="stack data-panel">
      {error && <Notice tone="error">{error}</Notice>}
      <section className="card setting">
        <div><h2 className="card-title">Export project data</h2>
          <p className="muted">Download everything in this project as a machine-readable JSON file: the project, its runs and briefs, sources, memory with its history, and the decision journal.</p></div>
        <a href={`/api/projects/${project.id}/export`} download className="btn btn-secondary">Download JSON</a>
      </section>
      <section className="card setting">
        <div><h2 className="card-title">{project.archivedAt ? "Restore project" : "Archive project"}</h2>
          <p className="muted">{project.archivedAt
            ? "Bring it back to your active projects so you can start new runs."
            : "Move it out of your active list. Nothing is deleted, and new runs are turned off until you restore it."}</p></div>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => archive(!project.archivedAt)}>{project.archivedAt ? "Restore" : "Archive"}</button>
      </section>
      <section className="card setting danger-zone">
        <div><h2 className="card-title">Delete project</h2>
          <p className="muted">Permanently delete this project and everything in it: runs, briefs, sources, memory and the decision journal. This cannot be undone. Export it first if you may need it.</p></div>
        <button type="button" className="btn btn-danger" onClick={() => setConfirmDelete(true)}>Delete project…</button>
      </section>
      <ConfirmDialog open={confirmDelete} title={`Delete “${project.title}”?`} confirmLabel="Delete permanently" danger busy={busy}
        onConfirm={remove} onCancel={() => setConfirmDelete(false)}>
        <p>Every run, brief, source, memory and decision in this project is deleted for good. This cannot be undone.</p>
      </ConfirmDialog>
    </div>
  );
}
