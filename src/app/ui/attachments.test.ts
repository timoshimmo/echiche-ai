import { describe, expect, it } from "vitest";
import { collectDrafts, type Draft, linksInText } from "./attachments";

describe("links written in the question are read too (ADR-012)", () => {
  it("finds https, http and www addresses, trims punctuation, upgrades to https and de-duplicates", () => {
    expect(linksInText("Read https://example.org/report, and www.example.com/plan. Also (http://example.net/a)! https://example.org/report"))
      .toEqual(["https://example.org/report", "https://www.example.com/plan", "https://example.net/a"]);
    expect(linksInText("No links here, just example dot com.")).toEqual([]);
  });

  it("sends a link left in the link field and links from the question, within the limits", () => {
    const file = { kind: "file", file: new File(["x"], "a.txt") } as Draft;
    const { drafts, skipped, error } = collectDrafts([file], "example.org/typed", "See https://a.example/1 https://b.example/2 https://c.example/3");
    expect(error).toBeNull();
    expect(drafts.filter(d => d.kind === "link").map(d => (d as { url: string }).url))
      .toEqual(["https://example.org/typed", "https://a.example/1", "https://b.example/2"]);
    expect(skipped).toEqual(["https://c.example/3"]);
  });

  it("does not duplicate a link that is both attached and written in the question", () => {
    const link: Draft = { kind: "link", url: "https://example.org/x" };
    expect(collectDrafts([link], "", "as in https://example.org/x").drafts).toHaveLength(1);
    expect(collectDrafts([link], "https://example.org/x", "").error).toBeNull();
  });

  it("reports a malformed link left in the link field instead of silently dropping it", () => {
    expect(collectDrafts([], "ftp://example.org", "").error).toMatch(/https/);
    expect(collectDrafts([], "http://example.org/a", "").drafts).toEqual([{ kind: "link", url: "https://example.org/a" }]);
    expect(collectDrafts([], "not a url with spaces", "").error).toMatch(/https/);
  });
});

describe("attachment picker", () => {
  it("tells the user that links in the question will be read", async () => {
    const { createElement: h } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { AttachmentPicker } = await import("./attachments");
    const html = renderToStaticMarkup(h(AttachmentPicker, {
      drafts: [], onChange: () => {}, link: "", onLinkChange: () => {}, foundLinks: ["https://example.org/report"]
    }));
    expect(html).toContain('role="status"');
    expect(html).toContain("Links in your question will be read too: example.org/report");
  });
});
