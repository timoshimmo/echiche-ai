import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { config } from "@/middleware";
import PrivacyPage from "./privacy/page";
import { SiteFooter } from "./site-footer";
import TermsPage from "./terms/page";

/** M9 P0-1 / P0-3: legal pages, support contact and the pilot disclaimer are always reachable. */
describe("privacy notice, terms and support contact", () => {
  it("are public: the page-protection middleware does not cover them", () => {
    const matcher = new RegExp(`^${config.matcher[0]}$`);
    for (const path of ["/privacy", "/terms", "/login"]) expect(matcher.test(path)).toBe(false);
    for (const path of ["/", "/projects"]) expect(matcher.test(path)).toBe(true);
  });

  it("name the processors, the rights and the support contact", () => {
    const privacy = renderToStaticMarkup(createElement(PrivacyPage));
    for (const text of ["OpenAI", "Brave Search", "Supabase", "Render", "Frankfurt", "Nigeria Data Protection Commission",
      "Export project data", "info@echiche-ai.com", "+234 805 752 7307", "tel:+2348057527307"]) {
      expect(privacy).toContain(text);
    }
    const terms = renderToStaticMarkup(createElement(TermsPage));
    expect(terms).toMatch(/not\s+legal, financial/);
    expect(terms).toContain("info@echiche-ai.com");
  });

  it("show a draft banner until legal review signs them off", () => {
    expect(renderToStaticMarkup(createElement(PrivacyPage))).toContain("Draft for legal review");
  });

  it("the footer carries the advice disclaimer and every link", () => {
    const footer = renderToStaticMarkup(createElement(SiteFooter));
    expect(footer).toContain("not professional advice");
    for (const href of ['href="/privacy"', 'href="/terms"', 'href="mailto:info@echiche-ai.com"', 'href="tel:+2348057527307"']) {
      expect(footer).toContain(href);
    }
  });
});
