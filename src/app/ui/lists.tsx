"use client";
// Rows used by the overview, projects list and project workspace. Each row is one link.
import Link from "next/link";
import type { Project, ThoughtRun } from "@/lib/domain/types";
import { relativeTime, runTitle, STATUS, TIER_LABEL } from "../lib/run-display";
import { Badge } from "./primitives";

export function RunStatusBadge({ status }: { status: ThoughtRun["status"] }) {
  const s = STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function RunRow({ run, projectTitle }: { run: ThoughtRun; projectTitle?: string }) {
  const action = run.status === "awaiting_user_review" ? (run.result?.schemaVersion === "decision-brief.v1" ? "Review the brief" : "Review the result")
    : run.status === "paused_for_budget" ? "Decide on budget" : null;
  return (
    <li>
      <Link href={`/projects/${run.projectId}/runs/${run.id}`} className="list-row">
        <span className="list-row-main">
          <span className="list-row-title">{runTitle(run)}</span>
          <span className="list-row-meta">
            {projectTitle && <><span>{projectTitle}</span><span aria-hidden="true">·</span></>}
            <span>Started {relativeTime(run.createdAt)}</span>
            {run.route.tier && <><span aria-hidden="true">·</span><span>{TIER_LABEL[run.route.tier]}</span></>}
            {run.result && run.generation.mode === "demo" && <><span aria-hidden="true">·</span><span>Demo mode</span></>}
          </span>
        </span>
        <span className="list-row-side">
          <RunStatusBadge status={run.status} />
          {action && <span className="list-row-action">{action} <span aria-hidden="true">→</span></span>}
        </span>
      </Link>
    </li>
  );
}

export function ProjectRow({ project, latestRun, lastActivity }: { project: Project; latestRun?: ThoughtRun | null; lastActivity?: string }) {
  return (
    <li>
      <Link href={`/projects/${project.id}`} className="list-row">
        <span className="list-row-main">
          <span className="list-row-title">{project.title}</span>
          <span className="list-row-excerpt">{project.problemStatement}</span>
          <span className="list-row-meta">
            <span>{lastActivity ? `Last activity ${relativeTime(lastActivity)}` : `Updated ${relativeTime(project.updatedAt)}`}</span>
            {latestRun === null && <><span aria-hidden="true">·</span><span>No runs yet</span></>}
          </span>
        </span>
        <span className="list-row-side">
          {project.archivedAt && <Badge>Archived</Badge>}
          {latestRun && <RunStatusBadge status={latestRun.status} />}
          <span className="chevron" aria-hidden="true">›</span>
        </span>
      </Link>
    </li>
  );
}
