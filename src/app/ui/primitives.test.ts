import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Badge, ConfirmDialog, EmptyState, Field, Logo, Notice, Tabs } from "./primitives";

describe("UI primitives (design system)", () => {
  it("uses the supplied logo artwork with an accessible name", () => {
    expect(renderToStaticMarkup(h(Logo))).toContain('src="/brand/echiche-logo-colour.svg"');
    expect(renderToStaticMarkup(h(Logo, { variant: "symbol", tone: "dark" }))).toContain("/brand/echiche-symbol-colour-dark.svg");
    expect(renderToStaticMarkup(h(Logo, { variant: "tagline" }))).toMatch(/echiche-logo-tagline-colour\.svg" alt="Echiche"/);
  });

  it("announces errors as alerts and confirmations as status", () => {
    expect(renderToStaticMarkup(h(Notice, { tone: "error", children: "Failed" }))).toContain('role="alert"');
    expect(renderToStaticMarkup(h(Notice, { children: "Saved" }))).toContain('role="status"');
  });

  it("wires a field's label, hint and error to its control", () => {
    const html = renderToStaticMarkup(h(Field, { label: "Project name", hint: "2–120 characters", error: "Too short",
      children: props => h("input", { className: "input", ...props }) }));
    const id = /<label class="field-label" for="([^"]+)"/.exec(html)![1];
    expect(html).toContain(`id="${id}"`);
    expect(html).toContain(`aria-describedby="${id}-hint ${id}-error"`);
    expect(html).toContain('aria-invalid="true"');
  });

  it("renders tabs with one tabbable, selected tab controlling its panel", () => {
    const html = renderToStaticMarkup(h(Tabs, { tabs: [{ id: "a", label: "Thinking" }, { id: "b", label: "Memory", count: 2 }],
      selected: "b", onSelect: () => {}, label: "Project sections", idPrefix: "p" }));
    expect(html).toContain('role="tablist" aria-label="Project sections"');
    expect(html).toMatch(/id="p-tab-b" aria-controls="p-panel-b" aria-selected="true" tabindex="0"/);
    expect(html).toMatch(/id="p-tab-a" aria-controls="p-panel-a" aria-selected="false" tabindex="-1"/);
  });

  it("names the destructive action in a confirm dialog and keeps it closed until opened", () => {
    const html = renderToStaticMarkup(h(ConfirmDialog, { open: false, title: "Delete project?", confirmLabel: "Delete permanently", danger: true,
      onConfirm: () => {}, onCancel: () => {}, children: "This cannot be undone." }));
    expect(html).toMatch(/<dialog class="dialog" aria-labelledby="[^"]+">/);
    expect(html).not.toContain(" open");
    expect(html).toContain('class="btn btn-danger"');
    expect(html).toContain("Delete permanently");
  });

  it("marks decorative imagery as hidden and badges carry words, not colour alone", () => {
    expect(renderToStaticMarkup(h(EmptyState, { title: "No projects yet" }))).toContain('alt="" aria-hidden="true"');
    expect(renderToStaticMarkup(h(Badge, { tone: "warning", children: "Stale source" }))).toBe('<span class="badge badge-warning">Stale source</span>');
  });
});
