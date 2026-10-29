"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Project, ThoughtRun } from "@/lib/domain/types";
import { api, errorMessage } from "../lib/api";
import { isSettled, needsAttention } from "../lib/run-display";
import { ProjectRow, RunRow } from "../ui/lists";
import { Notice, Skeleton } from "../ui/primitives";

/** How many recent projects the overview reads runs for (no cross-project endpoint; audit R3). */
const RECENT = 5;

type Recent = { project: Project; runs: ThoughtRun[]; lastActivity: string };

const lastActivity = (project: Project, runs: ThoughtRun[]) =>
  [project.updatedAt, ...runs.map(r => r.updatedAt)].sort().at(-1)!;

export default function OverviewPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const all = await api<Project[]>("/api/projects");
      const candidates = [...all].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, RECENT);
      const withRuns = await Promise.all(candidates.map(async project => {
        const runs = await api<ThoughtRun[]>(`/api/projects/${project.id}/runs`);
        return { project, runs, lastActivity: lastActivity(project, runs) };
      }));
      setRecent(withRuns.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity)));
      setProjects(all);
    } catch (e) { setError(errorMessage(e, "Could not load your overview.")); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const attention = recent.flatMap(r => r.runs.filter(needsAttention).map(run => ({ run, title: r.project.title })));
  const running = recent.flatMap(r => r.runs.filter(run => !isSettled(run.status)).map(run => ({ run, title: r.project.title })));
  const first = projects !== null && projects.length === 0;

  return (
    <div className="overview">
      <div className="page-head">
        <div>
          <p className="eyebrow">Overview</p>
          <h1 className="display">{first ? "Welcome to Echiche" : "Welcome back"}</h1>
          <p className="lede">{first
            ? "Echiche helps you work through important decisions, step by step, and keeps the reasoning behind them so you can revisit it."
            : "Pick up where you left off, or bring a new decision."}</p>
        </div>
        {!first && <Link href="/projects/new" className="btn btn-primary">New project <span className="btn-arrow" aria-hidden="true">+</span></Link>}
      </div>

      {error && <Notice tone="error">{error} <button type="button" className="link-button" onClick={() => void load()}>Try again</button></Notice>}

      {projects === null && !error && <div className="card" aria-busy="true"><span className="visually-hidden">Loading your overview</span><Skeleton lines={4} /></div>}

      {first && <Onboarding />}

      {projects !== null && !first && <>
        {attention.length > 0 && (
          <section className="section" aria-labelledby="attention-title">
            <div className="section-title"><h2 id="attention-title">Needs your attention</h2></div>
            <ul className="list">{attention.map(({ run, title }) => <RunRow key={run.id} run={run} projectTitle={title} />)}</ul>
          </section>
        )}
        {running.length > 0 && (
          <section className="section" aria-labelledby="running-title">
            <div className="section-title"><h2 id="running-title">In progress</h2></div>
            <ul className="list">{running.map(({ run, title }) => <RunRow key={run.id} run={run} projectTitle={title} />)}</ul>
          </section>
        )}
        {attention.length === 0 && running.length === 0 && (
          <div className="calm-note"><strong>Nothing is waiting on you.</strong> No briefs to review and no runs in progress in your recent projects.</div>
        )}
        <section className="section" aria-labelledby="recent-title">
          <div className="section-title">
            <h2 id="recent-title">Continue where you left off</h2>
            <Link href="/projects">All projects ({projects.length})</Link>
          </div>
          <ul className="list">{recent.map(r => <ProjectRow key={r.project.id} project={r.project} latestRun={r.runs[0] ?? null} lastActivity={r.lastActivity} />)}</ul>
          {projects.length > RECENT && <p className="footnote">Showing your {RECENT} most recently updated projects. Briefs awaiting review are checked in these projects.</p>}
        </section>
      </>}
    </div>
  );
}

function Onboarding() {
  const steps: [string, string][] = [
    ["Frame the decision", "Create a project for an important question: what you are deciding, the context, and what is at stake."],
    ["Think it through", "Ask Echiche. It frames the decision, researches it where useful, challenges the assumptions and checks its claims, then writes a brief. You can watch each stage."],
    ["Review and keep what matters", "Read the brief and its evidence. Accept it to record the decision, and approve anything Echiche proposes to remember. Nothing is saved to memory without you."]
  ];
  return (
    <section className="onboarding card" aria-labelledby="how-title">
      <h2 id="how-title">How Echiche works</h2>
      <ol className="onboarding-steps">
        {steps.map(([title, text], i) => <li key={title}><span className="step-n" aria-hidden="true">{i + 1}</span><div><strong>{title}</strong><p>{text}</p></div></li>)}
      </ol>
      <p className="muted onboarding-note">Echiche can be wrong. It shows its sources and labels what is fact, inference or speculation so you can check what matters.</p>
      <Link href="/projects/new" className="btn btn-primary">Create your first project <span className="btn-arrow" aria-hidden="true">→</span></Link>
    </section>
  );
}
