/** Public contact and legal-document metadata, shown on every page (M9 P0-1). */
export const SUPPORT = {
  email: "info@echiche-ai.com",
  phone: "+234 805 752 7307",
  phoneHref: "tel:+2348057527307"
} as const;

export const LEGAL = {
  /** "draft" shows a banner on the privacy notice and terms until a legal review signs them off. */
  status: "draft" as "draft" | "final",
  lastUpdated: "28 October 2026",
  /** Replace with the registered legal entity and address once confirmed. */
  operator: "Echiche"
};
