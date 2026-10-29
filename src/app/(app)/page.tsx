"use client";

import { FormEvent, Fragment, useEffect, useRef, useState } from "react";
import {
  RUN_ERROR_MESSAGES, RUN_STAGES, SETTLED_STATUSES,
  type Project, type RunStage, type ThoughtRunWithEvents
} from "@/lib/domain/types";
import { ROUTING_POLICY } from "@/lib/domain/routing";
import { DecisionBriefView, generationDetail, generationLabel } from "../decision-brief";
import { Journal } from "../journal";

const STATUS_LABEL: Record<ThoughtRunWithEvents["status"], string> = {
  queued: "Queued", planning: "Planning", researching: "Researching", critiquing: "Critiquing",
  verifying: "Verifying", synthesizing: "Synthesizing", awaiting_user_review: "Ready for review",
  completed: "✓ Accepted", failed: "✕ Failed", cancelled: "Cancelled", paused_for_budget: "Paused: budget"
};
const STAGE_LABEL: Record<RunStage, string> = {
  planning: "Plan", researching: "Research", critiquing: "Critique", verifying: "Verify", synthesizing: "Synthesize"
};
const POLL_MS = 1500;

/** The five stages every standard or deep run goes through (RUN_STAGES). */
const WORKFLOW: [string, string, string][] = [
  ["01", "Frame", "Define the decision"], ["02", "Research", "Find evidence"], ["03", "Challenge", "Test assumptions"],
  ["04", "Verify", "Check each claim"], ["05", "Brief", "Recommend a next step"]
];

type Depth = "auto" | "quick" | "standard" | "deep";
const DEPTHS: [Depth, string][] = [
  ["auto", "Automatic (recommended)"],
  ["quick", "Quick: no research or checks"],
  ["standard", "Standard: research and checks"],
  ["deep", "Deep: more research"]
];
const DEPTH_HINT: Record<Depth, string> = {
  auto: "Echiche sizes the run to the question and shows why.",
  quick: "Frames and answers only: no web research, critique or verification.",
  standard: "Researches, critiques and verifies claims before the brief.",
  deep: "More research; may use a stronger model for the brief when sources conflict."
};
/** Stages a tier leaves out (ADR-010); the worker checkpoints them as skipped. */
const ROUTED: Partial<Record<RunStage, "research" | "critique" | "verify">> = { researching: "research", critiquing: "critique", verifying: "verify" };
function skipped(route: ThoughtRunWithEvents["route"], stage: RunStage): boolean {
  const flag = ROUTED[stage];
  return !!(route.tier && flag && !ROUTING_POLICY.tiers[route.tier].pipeline[flag]);
}
function escalationText(text: string): string {
  return text.replace("high_severity_critique", "a high-severity critique").replace("contradiction", "sources disagree");
}
const TIER_LABEL = { low: "Quick", medium: "Standard", high: "Deep" } as const;

/** Why the router chose this tier, in the words of its deterministic reasons (ADR-010). */
function routeReasons(route: ThoughtRunWithEvents["route"]): string[] {
  const reasons = route.reasons.map(r => `${r.signal.replace("_", " ")} ${r.points >= 0 ? "+" : ""}${r.points}: ${r.detail}`);
  return [...(reasons.length ? reasons : ["no signals matched"]), `policy ${route.policyVersion ?? "unknown"}`];
}

export default function HomePage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [title, setTitle] = useState("");
  const [problemStatement, setProblemStatement] = useState("");
  const [prompt, setPrompt] = useState("");
  const [depth, setDepth] = useState<Depth>("auto");
  const [run, setRun] = useState<ThoughtRunWithEvents | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
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

  async function loadProjects() {
    const { response, body } = await api("/api/projects");
    if (!response.ok) throw new Error(body.error?.message ?? "Could not load projects");
    setProjects(body.data);
    if (!selectedId && body.data[0]) setSelectedId(body.data[0].id);
  }
  useEffect(() => {
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
        body: JSON.stringify({ prompt, depth })
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
    <div className="page">
      <section className="hero">
        <p className="eyebrow">EARLY PILOT</p>
        <h1>Think beyond the<br /><em>next answer.</em></h1>
        <p className="hero-copy">Keep the question, challenge the assumptions, and turn uncertainty into a next step. Each run frames your decision, researches it where useful, challenges it, checks its claims and writes a brief you review. Echiche can be wrong: check what matters.</p>
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
            <label>Depth<select value={depth} onChange={e => setDepth(e.target.value as Depth)}>
              {DEPTHS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select><small className="hint">{DEPTH_HINT[depth]}</small></label>
            <button disabled={busy || !selectedId || !settled}>{!settled ? "Run in progress…" : "Run deep thought"} <span>↗</span></button>
          </form>
          <div className="workflow">{WORKFLOW.map(([n, name, what], i) => <Fragment key={n}>{i > 0 && <i>→</i>}<div><span>{n}</span><strong>{name}</strong><small>{what}</small></div></Fragment>)}</div>
          <p className="workflow-note">Quick runs skip research, critique and verification, and say so.</p>
        </section>
      </div>
      {run && <section className="results" aria-live="polite">
        <div className="result-head">
          <div><p className="eyebrow">{result ? "DECISION BRIEF" : "THOUGHT RUN"}</p><h2>{result?.schemaVersion === "reasoning-scaffold.v1" ? result.data.summary : result ? result.data.decision_question : run.prompt}</h2>
            {(result || run.generation.mode === "model") && <p className="generation" title={generationDetail(run.generation) ?? undefined}>{generationLabel(run.generation)}</p>}</div>
          <span className="status-pill">{STATUS_LABEL[run.status]}{run.cancelRequested && !settled ? " · cancelling" : ""}</span>
        </div>
        {run.route.tier && <details className="route">
          <summary>{TIER_LABEL[run.route.tier]} run{run.route.requestedDepth === "auto" ? ", chosen automatically" : ", as you asked"}
            {run.route.escalation && <> · {escalationText(run.route.escalation)}</>}</summary>
          <ul>{routeReasons(run.route).map(line => <li key={line}>{line}</li>)}</ul>
        </details>}
        <ol className="stage-progress">
          {RUN_STAGES.map(stage => {
            if (skipped(run.route, stage)) return <li key={stage} className="skipped">– {STAGE_LABEL[stage]} skipped</li>;
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
        {result?.schemaVersion === "decision-brief.v1" && <DecisionBriefView brief={result.data} evidence={run.evidence} remembered={run.remembered} />}
        <p className="usage">Used {run.usage.steps}/{run.budget.maxSteps} steps · {Math.round(run.usage.activeSeconds)}s of {run.budget.maxActiveSeconds}s · ${run.usage.costUsd.toFixed(4)} of ${run.budget.maxCostUsd.toFixed(2)}</p>
        {generationDetail(run.generation) && <p className="usage">{generationDetail(run.generation)}</p>}
        {run.events?.length ? <details><summary>Run event log ({run.events.length})</summary><ul>{run.events.map(event => <li key={event.id}><b>{event.stage}</b> — {event.message}</li>)}</ul></details> : null}
      </section>}
      {selectedId && <Journal projectId={selectedId} refreshKey={`${run?.id ?? ""}:${run?.status ?? ""}`} onDeleted={() => {
        setProjects(current => current.filter(p => p.id !== selectedId)); setSelectedId(""); setRun(null);
        setMessage("Project deleted permanently.");
      }} />}
    </div>
  );
}
