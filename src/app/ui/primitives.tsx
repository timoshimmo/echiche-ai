"use client";
// Echiche UI primitives (docs/ui-ux/DESIGN_SYSTEM.md). Styling lives in globals.css; these components
// add the markup and accessibility behaviour that must not be re-invented per screen.
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from "react";

type Tone = "neutral" | "success" | "warning" | "danger" | "focus" | "ink";

/** The supplied logo artwork (public/brand), never redrawn. `dark` is for ink grounds. */
export function Logo({ variant = "horizontal", tone = "light", className = "" }:
  { variant?: "horizontal" | "symbol" | "tagline"; tone?: "light" | "dark"; className?: string }) {
  const file = variant === "symbol"
    ? `echiche-symbol-colour${tone === "dark" ? "-dark" : ""}.svg`
    : `echiche-logo-${variant === "tagline" ? "tagline-" : ""}colour${tone === "dark" ? "-dark" : ""}.svg`;
  // Plain <img>: the SVGs are tiny, static and already optimised; next/image adds nothing here.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={`/brand/${file}`} alt="Echiche" className={className} />;
}

export function Badge({ tone = "neutral", plain = false, children, title }:
  { tone?: Tone; plain?: boolean; children: ReactNode; title?: string }) {
  return <span className={`badge${tone === "neutral" ? "" : ` badge-${tone}`}${plain ? " badge-plain" : ""}`} title={title}>{children}</span>;
}

/** Confirmation (role=status) or problem (role=alert) message. */
export function Notice({ tone = "success", children, onDismiss }:
  { tone?: "success" | "error" | "warning" | "info"; children: ReactNode; onDismiss?: () => void }) {
  return (
    <div className={`notice${tone === "success" ? "" : ` notice-${tone}`}`} role={tone === "error" ? "alert" : "status"}>
      <div className="notice-body">{children}</div>
      {onDismiss && <button type="button" className="btn btn-ghost btn-sm notice-dismiss" onClick={onDismiss} aria-label="Dismiss message">Dismiss</button>}
    </div>
  );
}

export function EmptyState({ title, children, action, symbol = true }:
  { title: string; children?: ReactNode; action?: ReactNode; symbol?: boolean }) {
  return (
    <div className="empty-state">
      {/* Decorative: the brand path symbol (alt="" so screen readers skip it). */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {symbol && <img src="/brand/echiche-path-illustration.svg" alt="" aria-hidden="true" />}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return <span className="loading-row" role="status"><span className="spinner" aria-hidden="true" />{label ?? <span className="visually-hidden">Loading</span>}</span>;
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => <span key={i} className="skeleton" style={{ width: `${92 - i * 14}%` }} />)}
    </div>
  );
}

/** Label + control + hint + error, wired with ids so assistive technology reads them together. */
export function Field({ label, hint, error, children }:
  { label: string; hint?: ReactNode; error?: string | null; children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => ReactNode }) {
  const id = useId();
  const described = [hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>{label}</label>
      {children({ id, "aria-describedby": described, ...(error ? { "aria-invalid": true } : {}) })}
      {hint && <span className="field-hint" id={`${id}-hint`}>{hint}</span>}
      {error && <span className="field-error" id={`${id}-error`}>{error}</span>}
    </div>
  );
}

export type TabItem = { id: string; label: string; count?: number };

/** WAI-ARIA tabs with arrow-key, Home and End navigation. Panels use id `${idPrefix}-panel-${tab.id}`. */
export function Tabs({ tabs, selected, onSelect, label, idPrefix }:
  { tabs: TabItem[]; selected: string; onSelect: (id: string) => void; label: string; idPrefix: string }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex(t => t.id === selected);
    const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
      : event.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length
      : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    onSelect(tabs[next].id);
    refs.current[tabs[next].id]?.focus();
  }
  return (
    <div className="tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map(tab => (
        <button key={tab.id} ref={el => { refs.current[tab.id] = el; }} type="button" role="tab" className="tab"
          id={`${idPrefix}-tab-${tab.id}`} aria-controls={`${idPrefix}-panel-${tab.id}`}
          aria-selected={tab.id === selected} tabIndex={tab.id === selected ? 0 : -1} onClick={() => onSelect(tab.id)}>
          {tab.label}{tab.count !== undefined && <span className="tab-count">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * Modal confirmation on the native <dialog> (focus trap, Esc to cancel, inert page behind).
 * Used for irreversible actions; the confirm button names the action, never just "OK".
 */
export function ConfirmDialog({ open, title, children, confirmLabel, danger = false, busy = false, onConfirm, onCancel }:
  { open: boolean; title: string; children: ReactNode; confirmLabel: string; danger?: boolean; busy?: boolean;
    onConfirm: () => void; onCancel: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} className="dialog" aria-labelledby={titleId} onCancel={e => { e.preventDefault(); if (!busy) onCancel(); }}>
      <div className="dialog-body">
        <h2 id={titleId}>{title}</h2>
        <div>{children}</div>
      </div>
      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy} autoFocus>Cancel</button>
        <button type="button" className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={onConfirm} disabled={busy}>
          {busy && <span className="spinner" aria-hidden="true" />}{confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
