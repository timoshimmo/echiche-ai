/** Public contact and legal-document metadata, shown on every page (M9 P0-1). */
export const SUPPORT = {
  email: "info@echiche-ai.com"
} as const;

export const LEGAL = {
  /** "draft" shows a banner on that page until its bracketed items are confirmed. */
  privacyStatus: "final" as "draft" | "final",
  termsStatus: "draft" as "draft" | "final",
  /** When the privacy notice last changed. */
  privacyUpdated: "3 November 2026",
  /** When the terms last changed. */
  termsUpdated: "28 October 2026",
  /** Replace with the registered legal entity and address once confirmed. */
  operator: "Echiche"
};
