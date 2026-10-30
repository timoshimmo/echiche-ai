"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { RUN_ERROR_MESSAGES, type Project, type ThoughtRunWithEvents } from "@/lib/domain/types";
import { DecisionBriefView, generationDetail, generationLabel, ScaffoldView } from "../../../../../decision-brief";
import { api, ApiError, errorMessage } from "../../../../../lib/api";
import { formatDate, isSettled, routeReasons, routeSummary, STAGES, stageStates } from "../../../../../lib/run-display";
import { AttachmentList } from "../../../../../ui/attachments";
import { RunStatusBadge } from "../../../../../ui/lists";
import { Badge, ConfirmDialog, EmptyState, Notice, Skeleton } from "../../../../../ui/primitives";

const POLL_MS = 1500;

export default function RunPage() {
  const { projectId, runId } = useParams<{ projectId: string; runId: string }>();
  const [run, setRun] = useState<ThoughtRunWithEvents | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<{ text: string; missing?: boolean } | null>(null);
  const [note, setNote] = useState<{ text: string; tone?: "error"; journal?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isBrief = run?.result?.schemaVersion === "decision-brief.v1";

  /** Polls until the run settles (review, accepted, failed, cancelled or paused). */
  const track = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    const tick = async () => {
      try {
        const next = await api<ThoughtRunWithEvents>(`/api/runs/${runId}`);
        if (next.projectId !== projectId) throw new ApiError("Run not found", 404, "NOT_FOUND");
        setRun(next); setError(null);
        if (!isSettled(next.status)) timer.current = setTimeout(tick, POLL_MS);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) setError({ text: "Run not found", missing: true });
        else { setError({ text: errorMessage(e, "Lost track of the run.") }); timer.current = setTimeout(tick, POLL_MS * 4); }
      }
    };
    void tick();
  }, [projectId, runId]);

  useEffect(() => {
    track();
    api<Project>(`/api/projects/${projectId}`).then(setProject).catch(() => {});
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [projectId, track]);

  async function act(action: "cancel" | "accept" | "resume") {
    setBusy(true); setNote(null);
    try {
      await api(`/api/runs/${runId}/${action}`, { method: "POST" });
      setConfirmCancel(false);
      if (action === "accept") setNote(isBrief
        ? { text: "Brief accepted and recorded as the current decision.", journal: true }
        : { text: "Marked as reviewed. No decision was recorded, because this run has no brief." });
      if (action === "resume") setNote({ text: "More budget approved. The run is continuing." });
      if (action === "cancel") setNote({ text: "Cancelling. The run stops after its current step." });
      track();
    } catch (e) { setNote({ text: errorMessage(e, "That action failed."), tone: "error" }); }
    finally { setBusy(false); }
  }

  if (error?.missing) {
    return <EmptyState title="Run not found" action={<Link href={`/projects/${projectId}`} className="btn btn-primary">Back to the project</Link>}>
      It may belong to a deleted project, or the link is wrong.</EmptyState>;
  }
  if (!run) {
    return error
      ? <Notice tone="error">{error.text}</Notice>
      : <div aria-busy="true"><span className="visually-hidden">Loading run</span><Skeleton lines={6} /></div>;
  }

  const settled = isSettled(run.status);
  const result = run.result;
  const reason = run.errorCode ? RUN_ERROR_MESSAGES[run.errorCode] ?? null : null;
  const summary = routeSummary(run.route);
  const states = stageStates(run);
  const activeStage = states.find(s => s.state === "active");
  const canCancel = run.status === "queued" || run.status === "paused_for_budget" || (!settled && !run.cancelRequested);
  const detail = generationDetail(run.generation);

  return (
    <div className="run-page">
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <Link href="/projects">Projects</Link><span aria-hidden="true">/</span>
        <Link href={`/projects/${projectId}`}>{project?.title ?? "Project"}</Link><span aria-hidden="true">/</span>
        <span aria-current="page">Run from {formatDate(run.createdAt)}</span>
      </nav>

      <header className="run-head">
        <div className="row">
          <RunStatusBadge status={run.status} />
          {run.cancelRequested && !settled && <Badge>Cancelling</Badge>}
          {(result || run.generation.mode === "model") &&
            <Badge tone={run.generation.mode === "demo" ? "warning" : "neutral"} title={detail ?? undefined}>{generationLabel(run.generation)}</Badge>}
        </div>
        <p className="eyebrow">Your question</p>
        <h1 className="run-question">{run.prompt}</h1>
        <p className="memory-meta">Started {formatDate(run.createdAt, true)}{run.completedAt ? ` · finished ${formatDate(run.completedAt, true)}` : ""}</p>
      </header>

      {note && <Notice tone={note.tone ?? "success"} onDismiss={() => setNote(null)}>
        {note.text}{note.journal && <> <Link href={`/projects/${projectId}?tab=journal`}>Open the decision journal</Link></>}
      </Notice>}
      {error && <Notice tone="warning">{error.text} Retrying…</Notice>}

      <section className="card progress-card" aria-labelledby="progress-title">
        <div className="section-title">
          <h2 id="progress-title">{settled ? "How this run went" : "Progress"}</h2>
          {!settled && <span className="loading-row"><span className="spinner" aria-hidden="true" />{activeStage ? `${STAGES[activeStage.stage].name} in progress` : "Waiting for a worker"}</span>}
        </div>
        <ol className="timeline" aria-label="Run stages">
          {states.map(({ stage, state }) => (
            <li key={stage} className={state}>
              <strong>{STAGES[stage].name}</strong>
              <span>{state === "skipped" ? "Skipped for this depth" : state === "done" ? "Done" : state === "active" ? `${STAGES[stage].what}…` : STAGES[stage].what}</span>
            </li>
          ))}
        </ol>
        <p className="visually-hidden" aria-live="polite">{activeStage ? `Now: ${STAGES[activeStage.stage].name}` : `Status: ${run.status.replaceAll("_", " ")}`}</p>
        {summary && <details className="disclosure route-detail">
          <summary>{summary}</summary>
          <ul>{routeReasons(run.route).map(line => <li key={line}>{line}</li>)}</ul>
        </details>}
        {reason && <Notice tone={run.status === "failed" ? "error" : "warning"}><strong>{run.status === "failed" ? "Why it failed: " : ""}</strong>{reason}</Notice>}

        {(canCancel || run.status === "paused_for_budget" || run.status === "awaiting_user_review") && (
          <div className="run-actions">
            {run.status === "awaiting_user_review" && <div className="accept-block">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act("accept")}>{isBrief ? "Accept brief" : "Mark as reviewed"}</button>
              <span className="field-hint">{isBrief ? <>Records the recommendation as this project&rsquo;s current decision. You can revise it later.</> : "No decision is recorded for a demo template."}</span>
            </div>}
            {run.status === "paused_for_budget" && <div className="accept-block">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act("resume")}>Approve more budget and continue</button>
              <span className="field-hint">Lets this run use another step budget, within your daily spending limit.</span>
            </div>}
            {canCancel && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setConfirmCancel(true)}>Cancel run</button>}
          </div>
        )}
      </section>

      <AttachmentList items={run.attachments} settled={settled} />

      {result?.schemaVersion === "reasoning-scaffold.v1" && <ScaffoldView result={result.data} />}
      {result?.schemaVersion === "decision-brief.v1" &&
        <DecisionBriefView brief={result.data} evidence={run.evidence} remembered={run.remembered} projectId={projectId} />}
      {run.status === "awaiting_user_review" && result && (
        <section className="decide-bar" aria-labelledby="decide-title">
          <div>
            <h2 id="decide-title">Ready to decide?</h2>
            <p className="muted">{result.schemaVersion === "decision-brief.v1"
              ? "Accepting records the recommendation as this project’s current decision, with its rationale. You can revise it later; nothing is overwritten."
              : "This is a template, not a recommendation, so accepting it records no decision. It only marks the run as reviewed."}</p>
          </div>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act("accept")}>{isBrief ? "Accept brief" : "Mark as reviewed"}</button>
        </section>
      )}
      {!result && settled && run.status !== "paused_for_budget" &&
        <EmptyState title="No brief from this run">{run.status === "cancelled" ? "The run was cancelled before it wrote a brief." : "The run ended before it could write a brief."} Start a new run from the project when you are ready.</EmptyState>}

      <details className="disclosure run-details">
        <summary>Run details</summary>
        <dl className="details-grid">
          <dt>Steps</dt><dd>{run.usage.steps} of {run.budget.maxSteps}</dd>
          <dt>Processing time</dt><dd>{Math.round(run.usage.activeSeconds)}s of {run.budget.maxActiveSeconds}s</dd>
          <dt>Searches</dt><dd>{run.usage.researchCalls} of {run.budget.maxResearchCalls}</dd>
          <dt>Cost</dt><dd>${run.usage.costUsd.toFixed(4)} of ${run.budget.maxCostUsd.toFixed(2)}</dd>
          <dt>Produced by</dt><dd>{generationLabel(run.generation)}{detail ? <><br /><span className="mono">{detail}</span></> : null}</dd>
          {run.attempt > 1 && <><dt>Attempts</dt><dd>{run.attempt}</dd></>}
        </dl>
        {run.events.length > 0 && <>
          <h3 className="subhead">Event log ({run.events.length})</h3>
          <ol className="event-log">{run.events.map(event => <li key={event.id}><span className="mono">{formatDate(event.createdAt, true)}</span> <b>{event.stage}</b> {event.message}</li>)}</ol>
        </>}
      </details>

      <ConfirmDialog open={confirmCancel} title="Cancel this run?" confirmLabel="Cancel run" cancelLabel="Keep running" danger busy={busy}
        onConfirm={() => act("cancel")} onCancel={() => setConfirmCancel(false)}>
        <p>It stops after its current step and will not write a brief. Its budget still counts towards your daily spending limit for 24 hours.</p>
      </ConfirmDialog>
    </div>
  );
}
