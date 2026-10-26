"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import {
  RUN_ERROR_MESSAGES, RUN_STAGES, SETTLED_STATUSES,
  type CurrentUser, type Project, type RunStage, type ThoughtRunWithEvents
} from "@/lib/domain/types";
import { DecisionBriefView, generationDetail, generationLabel } from "./decision-brief";

const STATUS_LABEL: Record<ThoughtRunWithEvents["status"], string> = {
  queued: "Queued", planning: "Planning", researching: "Researching", critiquing: "Critiquing",
  verifying: "Verifying", synthesizing: "Synthesizing", awaiting_user_review: "Ready for review",
  completed: "✓ Accepted", failed: "✕ Failed", cancelled: "Cancelled", paused_for_budget: "Paused: budget"
};
const STAGE_LABEL: Record<RunStage, string> = {
  planning: "Plan", researching: "Research", critiquing: "Critique", verifying: "Verify", synthesizing: "Synthesize"
};
const POLL_MS = 1500;

export default function HomePage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [title, setTitle] = useState("");
  const [problemStatement, setProblemStatement] = useState("");
  const [prompt, setPrompt] = useState("");
  const [run, setRun] = useState<ThoughtRunWithEvents | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [user, setUser] = useState<CurrentUser | null>(null);
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** fetch wrapper: a 401 means the session ended, so go back to sign-in. */
  async function api(path: string, init?: RequestInit) {
    const response = await fetch(path, { cache: "no-store", ...init });
    if (response.status === 401) {
      window.location.assign("/login");
      throw new Error("Your session has ended. Please sign in again.");
    }
    return { response, body: await response.json() };
  }

  async function loadUser() {
    const { response, body } = await api("/api/me");
    if (response.ok) setUser(body.data);
  }

  async function loadProjects() {
    const { response, body } = await api("/api/projects");
    if (!response.ok) throw new Error(body.error?.message ?? "Could not load projects");
    setProjects(body.data);
    if (!selectedId && body.data[0]) setSelectedId(body.data[0].id);
  }
  useEffect(() => {
    loadUser().catch(() => {});
    loadProjects().catch(e => setMessage(e.message));
    return () => { if (poll.current) clearTimeout(poll.current); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Polls the run until it settles (review, accepted, failed, cancelled or paused). */
  function track(runId: string) {
    if (poll.current) clearTimeout(poll.current);
    const tick = async () => {
      try {
        const { response, body } = await api(`/api/runs/${runId}`);
        if (!response.ok) throw new Error(body.error?.message ?? "Could not load the run");
        setRun(body.data);
        if (!SETTLED_STATUSES.includes(body.data.status)) poll.current = setTimeout(tick, POLL_MS);
      } catch (e) {
        setMessage(e instanceof Error ? e.message : "Lost track of the run; refresh to try again.");
      }
    };
    void tick();
  }

  async function act(action: "cancel" | "accept" | "resume") {
    if (!run) return;
    setBusy(true); setMessage("");
    try {
      const { response, body } = await api(`/api/runs/${run.id}/${action}`, { method: "POST" });
      if (!response.ok) throw new Error(body.error?.message ?? "That action failed");
      track(run.id);
    } catch (e) { setMessage(e instanceof Error ? e.message : "Something went wrong"); }
    finally { setBusy(false); }
  }

  async function createProject(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage(""); setRun(null);
    try {
      const { response, body } = await api("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, problemStatement }) });
      if (!response.ok) throw new Error(body.error?.message ?? "Could not create project");
      setProjects(current => [body.data, ...current]); setSelectedId(body.data.id);
      setTitle(""); setProblemStatement(""); setPrompt(body.data.problemStatement);
      setMessage("Project created. You can now start a thought run.");
    } catch (e) { setMessage(e instanceof Error ? e.message : "Something went wrong"); }
    finally { setBusy(false); }
  }

  async function startRun(event: FormEvent) {
    event.preventDefault(); if (!selectedId) return;
    setBusy(true); setMessage(""); setRun(null);
    try {
      const { response, body } = await api(`/api/projects/${selectedId}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ prompt })
      });
      if (!response.ok) throw new Error(body.error?.message ?? "Could not start the run");
      setRun({ ...body.data, events: [] });
      track(body.data.id);
    } catch (e) { setMessage(e instanceof Error ? e.message : "Something went wrong"); }
    finally { setBusy(false); }
  }

  const result = run?.result ?? null;
  const settled = run ? SETTLED_STATUSES.includes(run.status) : true;
  const reason = run?.errorCode ? RUN_ERROR_MESSAGES[run.errorCode] ?? null : null;

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand-mark">E</div>
        <div><div className="brand">echiche</div><div className="tagline">Deep thought, with continuity.</div></div>
        <div className="mode">
          <span className="dot" />{user?.email ?? "Signed in"}
          <form method="post" action="/auth/sign-out"><button type="submit" className="link-button">Sign out</button></form>
        </div>
      </header>
      <section className="hero">
        <p className="eyebrow">FOUNDING BUILD · 0.1.0</p>
        <h1>Think beyond the<br /><em>next answer.</em></h1>
        <p className="hero-copy">Keep the question, challenge the assumptions, and turn uncertainty into a next step. This first slice proves the project → thought run → decision scaffold flow.</p>
      </section>
      {message && <div className="notice" role="status">{message}</div>}
      <div className="workspace">
        <section className="panel">
          <div className="section-heading"><span className="step">01</span><div><h2>Create a project</h2><p>Give a consequential question a home.</p></div></div>
          <form onSubmit={createProject} className="form-stack">
            <label>Project name<input value={title} onChange={e => setTitle(e.target.value)} minLength={2} maxLength={120} required placeholder="e.g. VOU launch strategy" /></label>
            <label>What are you trying to solve?<textarea value={problemStatement} onChange={e => setProblemStatement(e.target.value)} minLength={10} maxLength={5000} required rows={4} placeholder="Describe the decision, context, and what is at stake…" /></label>
            <button disabled={busy}>{busy ? "Working…" : "Create project"} <span>↗</span></button>
          </form>
          <div className="rule" />
          <div className="section-heading"><span className="step">02</span><div><h2>Choose a project</h2><p>Runs are attached to a project.</p></div></div>
          {projects.length === 0 ? <div className="empty">Your first project will appear here.</div> : <div className="project-list">{projects.map(project => <button key={project.id} type="button" className={`project-option ${selectedId === project.id ? "selected" : ""}`} onClick={() => { setSelectedId(project.id); setPrompt(project.problemStatement); setRun(null); }}><span className="project-icon">↗</span><span><strong>{project.title}</strong><small>{project.problemStatement}</small></span><span className="chevron">›</span></button>)}</div>}
        </section>
        <section className="panel thought-panel">
          <div className="section-heading"><span className="step">03</span><div><h2>Start a thought run</h2><p>A bounded, transparent first-pass workflow.</p></div></div>
          <form onSubmit={startRun} className="form-stack">
            <label>Your question or decision<textarea value={prompt} onChange={e => setPrompt(e.target.value)} minLength={10} maxLength={8000} required rows={5} placeholder="What decision do you need to make, and what do you need to understand?" /></label>
            <button disabled={busy || !selectedId || !settled}>{!settled ? "Run in progress…" : "Run deep thought"} <span>↗</span></button>
          </form>
          <div className="workflow"><div><span>01</span><strong>Frame</strong><small>Define the decision</small></div><i>→</i><div><span>02</span><strong>Challenge</strong><small>Test assumptions</small></div><i>→</i><div><span>03</span><strong>Synthesize</strong><small>Choose a next step</small></div></div>
        </section>
      </div>
      {run && <section className="results" aria-live="polite">
        <div className="result-head">
          <div><p className="eyebrow">{result ? "DECISION BRIEF" : "THOUGHT RUN"}</p><h2>{result?.schemaVersion === "reasoning-scaffold.v1" ? result.data.summary : result ? result.data.decision_question : run.prompt}</h2>
            {(result || run.generation.mode === "model") && <p className="generation" title={generationDetail(run.generation) ?? undefined}>{generationLabel(run.generation)}</p>}</div>
          <span className="status-pill">{STATUS_LABEL[run.status]}{run.cancelRequested && !settled ? " · cancelling" : ""}</span>
        </div>
        <ol className="stage-progress">
          {RUN_STAGES.map(stage => {
            const state = run.completedStages.includes(stage) ? "done" : run.status === stage ? "active" : "todo";
            return <li key={stage} className={state}>{state === "done" ? "✓ " : state === "active" ? "… " : ""}{STAGE_LABEL[stage]}</li>;
          })}
        </ol>
        {reason && <div className="caveat"><strong>{run.status === "failed" ? "Why it failed" : "Status"}</strong><p>{reason}</p></div>}
        <div className="run-actions">
          {(run.status === "queued" || run.status === "paused_for_budget" || (!settled && !run.cancelRequested)) &&
            <button type="button" disabled={busy} onClick={() => act("cancel")}>Cancel run</button>}
          {run.status === "paused_for_budget" &&
            <button type="button" disabled={busy} onClick={() => act("resume")}>Approve more budget and continue</button>}
          {run.status === "awaiting_user_review" &&
            <button type="button" disabled={busy} onClick={() => act("accept")}>Accept brief</button>}
        </div>
        {result?.schemaVersion === "reasoning-scaffold.v1" && <>
          <div className="stage-grid">{result.data.stages.map((stage, index) => <article className="stage-card" key={stage.stage}><span className="stage-number">0{index + 1}</span><h3>{stage.title}</h3><p>{stage.content}</p></article>)}</div>
          <div className="caveat"><strong>Important limitation</strong><p>{result.data.caveat}</p></div>
        </>}
        {result?.schemaVersion === "decision-brief.v1" && <DecisionBriefView brief={result.data} />}
        <p className="usage">Used {run.usage.steps}/{run.budget.maxSteps} steps · {Math.round(run.usage.activeSeconds)}s of {run.budget.maxActiveSeconds}s · ${run.usage.costUsd.toFixed(4)} of ${run.budget.maxCostUsd.toFixed(2)}</p>
        {generationDetail(run.generation) && <p className="usage">{generationDetail(run.generation)}</p>}
        {run.events?.length ? <details><summary>Run event log ({run.events.length})</summary><ul>{run.events.map(event => <li key={event.id}><b>{event.stage}</b> — {event.message}</li>)}</ul></details> : null}
      </section>}
      <footer><span>ECHICHE / STARTER REPOSITORY</span><span>Built for continuity, not an unrestricted agent swarm.</span></footer>
    </main>
  );
}
