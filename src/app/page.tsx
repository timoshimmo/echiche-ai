"use client";

import { FormEvent, useEffect, useState } from "react";
import type { CurrentUser, Project, ThoughtRunWithEvents } from "@/lib/domain/types";

const STATUS_LABEL: Record<ThoughtRunWithEvents["status"], string> = {
  queued: "Queued", running: "Running", succeeded: "✓ Succeeded", failed: "✕ Failed"
};

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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
      const { response, body } = await api(`/api/projects/${selectedId}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt }) });
      if (!response.ok) throw new Error(body.error?.message ?? "Could not run");
      setRun(body.data); setMessage(body.data.status === "succeeded" ? "Thought run completed." : `Thought run ended with status: ${body.data.status}.`);
    } catch (e) { setMessage(e instanceof Error ? e.message : "Something went wrong"); }
    finally { setBusy(false); }
  }

  const result = run?.result ?? null;

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
            <button disabled={busy || !selectedId}>{busy ? "Working through the stages…" : "Run deep thought"} <span>↗</span></button>
          </form>
          <div className="workflow"><div><span>01</span><strong>Frame</strong><small>Define the decision</small></div><i>→</i><div><span>02</span><strong>Challenge</strong><small>Test assumptions</small></div><i>→</i><div><span>03</span><strong>Synthesize</strong><small>Choose a next step</small></div></div>
        </section>
      </div>
      {run && result && <section className="results">
        <div className="result-head"><div><p className="eyebrow">THOUGHT RUN COMPLETE</p><h2>{result.summary}</h2></div><span className="status-pill">{STATUS_LABEL[run.status]}</span></div>
        <div className="stage-grid">{result.stages.map((stage, index) => <article className="stage-card" key={stage.stage}><span className="stage-number">0{index + 1}</span><h3>{stage.title}</h3><p>{stage.content}</p></article>)}</div>
        <div className="caveat"><strong>Important limitation</strong><p>{result.caveat}</p></div>
        {run.events?.length ? <details><summary>Run event log ({run.events.length})</summary><ul>{run.events.map(event => <li key={event.id}><b>{event.stage}</b> — {event.message}</li>)}</ul></details> : null}
      </section>}
      <footer><span>ECHICHE / STARTER REPOSITORY</span><span>Built for continuity, not an unrestricted agent swarm.</span></footer>
    </main>
  );
}
