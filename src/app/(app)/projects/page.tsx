"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Project } from "@/lib/domain/types";
import { api, errorMessage } from "../../lib/api";
import { ProjectRow } from "../../ui/lists";
import { EmptyState, Notice, Skeleton, Tabs } from "../../ui/primitives";

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<"active" | "archived">("active");

  const load = useCallback(async () => {
    setError("");
    try { setProjects(await api<Project[]>("/api/projects?includeArchived=true")); }
    catch (e) { setError(errorMessage(e, "Could not load your projects.")); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const [deleted, setDeleted] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("deleted")) {
      setDeleted(true);
      window.history.replaceState(null, "", "/projects");
    }
  }, []);

  const active = (projects ?? []).filter(p => !p.archivedAt);
  const archived = (projects ?? []).filter(p => p.archivedAt);
  const shown = view === "active" ? active : archived;

  return (
    <div>
      <div className="page-head">
        <div>
          <p className="eyebrow">Projects</p>
          <h1 className="display">Your projects</h1>
          <p className="lede">Each project holds one important question: its runs, what Echiche remembers about it, and the decisions you record.</p>
        </div>
        <Link href="/projects/new" className="btn btn-primary">New project <span className="btn-arrow" aria-hidden="true">+</span></Link>
      </div>

      {deleted && <Notice onDismiss={() => setDeleted(false)}>Project deleted permanently, with everything in it.</Notice>}
      {error && <Notice tone="error">{error} <button type="button" className="link-button" onClick={() => void load()}>Try again</button></Notice>}
      {projects === null && !error && <div className="card" aria-busy="true"><span className="visually-hidden">Loading projects</span><Skeleton lines={4} /></div>}

      {projects !== null && <>
        <Tabs idPrefix="projects" label="Project status" selected={view} onSelect={id => setView(id as "active" | "archived")}
          tabs={[{ id: "active", label: "Active", count: active.length }, { id: "archived", label: "Archived", count: archived.length }]} />
        <div role="tabpanel" id={`projects-panel-${view}`} aria-labelledby={`projects-tab-${view}`} className="tab-panel">
          {shown.length > 0
            ? <ul className="list">{shown.map(p => <ProjectRow key={p.id} project={p} />)}</ul>
            : view === "active"
              ? <EmptyState title="No active projects" action={<Link href="/projects/new" className="btn btn-primary">Create a project</Link>}>
                  Create a project for a decision you are working through.{archived.length > 0 ? " Archived projects are under Archived." : ""}
                </EmptyState>
              : <EmptyState title="Nothing archived">Archive a project from its Data tab when you no longer need it in your active list. Archived projects keep all their data.</EmptyState>}
        </div>
      </>}
    </div>
  );
}
