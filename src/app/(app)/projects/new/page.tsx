"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import type { Project } from "@/lib/domain/types";
import { api, errorMessage } from "../../../lib/api";
import { Field, Notice } from "../../../ui/primitives";

export default function NewProjectPage() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [problemStatement, setProblemStatement] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const project = await api<Project>("/api/projects", { method: "POST", body: { title: title.trim(), problemStatement: problemStatement.trim() } });
      router.push(`/projects/${project.id}?created=1`);
    } catch (e) { setError(errorMessage(e, "Could not create the project.")); setBusy(false); }
  }

  return (
    <div className="narrow">
      <nav aria-label="Breadcrumb" className="breadcrumb"><Link href="/projects">Projects</Link><span aria-hidden="true">/</span><span aria-current="page">New project</span></nav>
      <div className="page-head">
        <div>
          <h1 className="display">New project</h1>
          <p className="lede">A project is the home for one important question. You can ask Echiche about it as many times as you need; every run, memory and decision stays together here.</p>
        </div>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <form className="card stack" onSubmit={submit}>
        <Field label="Project name" hint="A short name you will recognise, 2–120 characters.">
          {props => <input {...props} className="input" value={title} onChange={e => setTitle(e.target.value)} minLength={2} maxLength={120} required placeholder="For example: Second office in Lagos" />}
        </Field>
        <Field label="What are you trying to decide?" hint="The decision, the context and what is at stake. 10–5,000 characters. The more specific, the more useful the brief.">
          {props => <textarea {...props} className="textarea" value={problemStatement} onChange={e => setProblemStatement(e.target.value)} minLength={10} maxLength={5000} required rows={6}
            placeholder="For example: Should we open a second office next year? We have 14 months of runway, hiring is slow, and two customers want local support." />}
        </Field>
        <div className="row">
          <button className="btn btn-primary" disabled={busy || title.trim().length < 2 || problemStatement.trim().length < 10}>
            {busy && <span className="spinner" aria-hidden="true" />}{busy ? "Creating…" : "Create project"}
          </button>
          <Link href="/projects" className="btn btn-ghost">Cancel</Link>
        </div>
      </form>
    </div>
  );
}
