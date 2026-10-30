"use client";
// ADR-012: attaching files and links to a question, and listing what a run was given.
// Only names, sizes and reading status are ever shown; the content is read by Echiche, not displayed.
import { type DragEvent, useId, useRef, useState } from "react";
import type { AttachmentKind, AttachmentSummary } from "@/lib/domain/types";
import { Badge } from "./primitives";

/** Mirrors the server's limits (src/lib/server/attachments.ts) so problems show before uploading. */
export const LIMITS = { total: 5, links: 3, images: 3, fileBytes: 5 * 1024 * 1024, imageBytes: 4 * 1024 * 1024 };
export const ACCEPT = ".txt,.md,.markdown,.csv,.tsv,.json,.pdf,.docx,.xlsx,image/png,image/jpeg,image/gif,image/webp";
const ALLOWED = /\.(txt|md|markdown|csv|tsv|json|pdf|docx|xlsx|png|jpe?g|gif|webp)$/i;

export type Draft = { kind: "file"; file: File } | { kind: "link"; url: string };

const KIND_LABEL: Record<AttachmentKind, string> = {
  text: "Text", pdf: "PDF", word: "Word", spreadsheet: "Spreadsheet", image: "Image", link: "Link"
};

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const isImage = (f: File) => f.type.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(f.name);

/**
 * Web addresses written in the question itself (https://…, http://… or www.…), so they are read like
 * links added with "Add link". Trailing punctuation is dropped; http is upgraded to https (the
 * reader only fetches https). Returns each address once, in order.
 */
export function linksInText(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/\b(?:https?:\/\/|www\.)[^\s<>"'()]+/gi)) {
    let url = match[0].replace(/[.,;:!?)\]}'"]+$/, "");
    if (/^www\./i.test(url)) url = `https://${url}`;
    url = url.replace(/^http:\/\//i, "https://");
    try { new URL(url); } catch { continue; }
    if (!found.includes(url)) found.push(url);
  }
  return found;
}

/** A link typed into the link field: a full https address, adding https:// when it was left out. */
export const normaliseLink = (value: string) => {
  const v = value.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v.replace(/^http:\/\//i, "https://"); // other schemes are refused by checkDrafts
  return `https://${v}`;
};

/**
 * Everything the question will carry: the attached items, a link still sitting in the link field
 * (not lost because "Add link" wasn't pressed), then links found in the question text, within the
 * limits. Returns the list and the addresses left out because of the limits.
 */
export function collectDrafts(drafts: Draft[], pendingLink: string, question: string): { drafts: Draft[]; skipped: string[]; error: string | null } {
  let all = [...drafts];
  if (pendingLink.trim()) {
    const draft: Draft = { kind: "link", url: normaliseLink(pendingLink) };
    const error = checkDrafts(all, [draft]);
    if (error && error !== "That link is already attached.") return { drafts, skipped: [], error };
    if (!error) all = [...all, draft];
  }
  const skipped: string[] = [];
  for (const url of linksInText(question)) {
    if (all.some(d => d.kind === "link" && d.url === url)) continue;
    if (checkDrafts(all, [{ kind: "link", url }]) === null) all = [...all, { kind: "link", url }];
    else skipped.push(url);
  }
  return { drafts: all, skipped, error: null };
}

/** Returns a reason the new items can't be added, or null. */
export function checkDrafts(current: Draft[], added: Draft[]): string | null {
  const all = [...current, ...added];
  if (all.length > LIMITS.total) return `Attach at most ${LIMITS.total} files and links in total.`;
  if (all.filter(d => d.kind === "link").length > LIMITS.links) return `Add at most ${LIMITS.links} links.`;
  if (all.filter(d => d.kind === "file" && isImage(d.file)).length > LIMITS.images) return `Attach at most ${LIMITS.images} images.`;
  for (const d of added) {
    if (d.kind === "link") {
      let url: URL | null = null;
      try { url = new URL(d.url); } catch { /* reported below */ }
      if (!url || url.protocol !== "https:") return "Links must be full web addresses starting with https://.";
      if (current.some(c => c.kind === "link" && c.url === d.url)) return "That link is already attached.";
      continue;
    }
    if (!ALLOWED.test(d.file.name)) return `“${d.file.name}” isn't a supported file. Use text, CSV, JSON, PDF, Word (.docx), Excel (.xlsx) or an image.`;
    if (d.file.size === 0) return `“${d.file.name}” is empty.`;
    if (isImage(d.file) && d.file.size > LIMITS.imageBytes) return `“${d.file.name}” is larger than 4 MB. Images must be 4 MB or smaller.`;
    if (d.file.size > LIMITS.fileBytes) return `“${d.file.name}” is larger than 5 MB.`;
  }
  return null;
}

/** The attachment area of the question form: add files (button or drop) and https links, remove any. */
export function AttachmentPicker({ drafts, onChange, disabled, link, onLinkChange, foundLinks = [] }: {
  drafts: Draft[]; onChange: (next: Draft[]) => void; disabled?: boolean;
  /** The link field's text, held by the form so a link that wasn't added with "Add link" is still sent. */
  link: string; onLinkChange: (value: string) => void;
  /** Addresses written in the question text, which will be read too. */
  foundLinks?: string[];
}) {
  const input = useRef<HTMLInputElement>(null);
  const setLink = onLinkChange;
  const [error, setError] = useState("");
  const [over, setOver] = useState(false);
  const id = useId();

  function add(added: Draft[]) {
    const problem = checkDrafts(drafts, added);
    setError(problem ?? "");
    if (!problem) onChange([...drafts, ...added]);
  }
  function addLink() {
    const value = link.trim();
    if (!value) return;
    const draft: Draft = { kind: "link", url: normaliseLink(value) };
    const problem = checkDrafts(drafts, [draft]);
    setError(problem ?? "");
    if (!problem) { onChange([...drafts, draft]); setLink(""); }
  }
  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setOver(false);
    if (disabled) return;
    add([...event.dataTransfer.files].map(file => ({ kind: "file" as const, file })));
  }

  return (
    <div className="field">
      <span className="field-label" id={`${id}-label`}>Attachments <span className="muted">(optional)</span></span>
      <div className={`attach-zone${over ? " over" : ""}`} onDragOver={e => { e.preventDefault(); if (!disabled) setOver(true); }}
        onDragLeave={() => setOver(false)} onDrop={onDrop} aria-labelledby={`${id}-label`} aria-describedby={`${id}-hint`} role="group">
        {drafts.length > 0 && (
          <ul className="attach-list" aria-label="Attached">
            {drafts.map((d, i) => (
              <li key={d.kind === "file" ? `${d.file.name}-${d.file.size}-${i}` : `${d.url}-${i}`} className="attach-chip">
                <span className="attach-kind">{d.kind === "link" ? "Link" : isImage(d.file) ? "Image" : (d.file.name.split(".").pop() ?? "").toUpperCase()}</span>
                <span className="attach-name">{d.kind === "file" ? d.file.name : d.url.replace(/^https:\/\//, "")}</span>
                {d.kind === "file" && <span className="attach-size">{fileSize(d.file.size)}</span>}
                <button type="button" className="attach-remove" disabled={disabled} onClick={() => { setError(""); onChange(drafts.filter((_, j) => j !== i)); }}
                  aria-label={`Remove ${d.kind === "file" ? d.file.name : d.url}`}>×</button>
              </li>
            ))}
          </ul>
        )}
        <div className="attach-actions">
          <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || drafts.length >= LIMITS.total} onClick={() => input.current?.click()}>
            Add files
          </button>
          <input ref={input} type="file" multiple accept={ACCEPT} hidden tabIndex={-1} aria-hidden="true"
            onChange={e => { add([...(e.target.files ?? [])].map(file => ({ kind: "file" as const, file }))); e.target.value = ""; }} />
          <div className="attach-link">
            <label className="visually-hidden" htmlFor={`${id}-link`}>Reference link</label>
            <input id={`${id}-link`} className="input input-sm" type="url" inputMode="url" placeholder="https://… reference link" value={link}
              disabled={disabled || drafts.length >= LIMITS.total} onChange={e => setLink(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addLink(); } }} maxLength={2048} />
            <button type="button" className="btn btn-ghost btn-sm" disabled={disabled || !link.trim()} onClick={addLink}>Add link</button>
          </div>
        </div>
        <p className="attach-drop muted" aria-hidden="true">or drop files here</p>
        {foundLinks.length > 0 && (
          <p className="attach-found" role="status">
            Links in your question will be read too: {foundLinks.map(u => u.replace(/^https:\/\//, "")).join(", ")}
          </p>
        )}
      </div>
      <span className="field-hint" id={`${id}-hint`}>
        Text, CSV, PDF, Word, Excel, images or web links, up to 5 (files up to 5 MB). Web addresses you write in your question are read as well. Echiche reads all of these to think through your question; their content isn&rsquo;t shown.
      </span>
      {error && <span className="field-error" role="alert">{error}</span>}
    </div>
  );
}

const STATUS: Record<AttachmentSummary["status"], { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  ready: { label: "Read", tone: "success" },
  pending: { label: "Waiting to be read", tone: "neutral" },
  failed: { label: "Couldn't be read", tone: "danger" }
};

/** What a run was given: names, kinds and whether each was read. Never the content. */
export function AttachmentList({ items, settled }: { items: AttachmentSummary[]; settled: boolean }) {
  if (items.length === 0) return null;
  return (
    <section className="card attached" aria-labelledby="attached-title">
      <h2 id="attached-title" className="card-title">Attached to this question</h2>
      <ul className="attached-list">
        {items.map(a => {
          const status = a.status === "pending" && settled ? { label: "Not read", tone: "neutral" as const } : STATUS[a.status];
          return (
            <li key={a.id}>
              <span className="attach-kind">{KIND_LABEL[a.kind]}</span>
              <span className="attached-main">
                {a.kind === "link" && a.url
                  ? <a href={a.url} target="_blank" rel="noopener noreferrer nofollow" className="attach-name">{a.name}<span className="visually-hidden"> (opens in a new tab)</span></a>
                  : <span className="attach-name">{a.name}</span>}
                {a.note && <span className="attached-note">{a.note}</span>}
              </span>
              <span className="attached-side">
                {a.kind !== "link" && a.sizeBytes > 0 && <span className="attach-size">{fileSize(a.sizeBytes)}</span>}
                <Badge tone={status.tone}>{status.label}</Badge>
                {a.status === "ready" && a.truncated && <Badge tone="warning">Partly used</Badge>}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="muted small">Echiche reads attachments to think through your question; their content isn&rsquo;t displayed. You can download what was read with Export project data.</p>
    </section>
  );
}
