"use client";
import { useState } from "react";

/** Password field with a show/hide toggle. Works as a plain password input when JavaScript is off. */
export function PasswordInput({ id, name, autoComplete, describedBy, invalid, minLength }:
  { id: string; name: string; autoComplete: "current-password" | "new-password"; describedBy?: string; invalid?: boolean; minLength?: number }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="password-field">
      <input className="input" id={id} name={name} type={shown ? "text" : "password"} required autoComplete={autoComplete}
        minLength={minLength} maxLength={200} aria-describedby={describedBy} aria-invalid={invalid || undefined} />
      <button type="button" className="password-toggle" onClick={() => setShown(s => !s)} aria-controls={id} aria-pressed={shown}>
        {shown ? "Hide" : "Show"}<span className="visually-hidden"> password</span>
      </button>
    </div>
  );
}
