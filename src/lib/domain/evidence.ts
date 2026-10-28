import "./zod-setup";
import { z } from "zod";

/**
 * Research provenance as read from echiche.sources / echiche.claims / echiche.claim_sources
 * (migration 0006, ADR-008). The worker writes these rows; the web app re-validates them on
 * read so a malformed row can never reach the UI (and only https links are ever rendered).
 */
const sourceKey = z.string().regex(/^S[0-9]{1,3}$/);
const passageKey = z.string().regex(/^S[0-9]{1,3}\.p[0-9]{1,2}$/);

export const evidenceSourceSchema = z
  .object({
    sourceId: sourceKey,
    url: z.url({ protocol: /^https$/ }).max(2048),
    domain: z.string().min(1).max(253),
    title: z.string().min(1).max(300),
    publisher: z.string().max(200).nullable(),
    publishedAt: z.string().max(40).nullable(),
    retrievedAt: z.string(),
    passages: z.array(z.object({ passage_id: passageKey, text: z.string().min(1).max(600) }).strict()).min(1).max(3)
  })
  .strict();

export const evidenceLinkSchema = z
  .object({
    sourceId: sourceKey,
    passageId: passageKey,
    relation: z.enum(["supports", "contradicts", "context"]),
    quote: z.string().min(1).max(500),
    verdict: z.enum(["supported", "partially_supported", "not_supported", "quote_not_found"]),
    note: z.string().max(500)
  })
  .strict();

export const evidenceClaimSchema = z
  .object({
    claimId: z.string().regex(/^C[0-9]{1,3}$/),
    text: z.string().min(1).max(500),
    label: z.enum(["fact", "inference", "hypothesis", "speculation", "unknown"]),
    status: z.enum(["verified", "partial", "unsupported", "invalid"]),
    freshness: z.enum(["fresh", "stale", "unknown"]),
    contradicted: z.boolean(),
    links: z.array(evidenceLinkSchema).max(3)
  })
  .strict();

export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;
export type EvidenceClaim = z.infer<typeof evidenceClaimSchema>;
export type EvidenceLink = z.infer<typeof evidenceLinkSchema>;
export type RunEvidence = { sources: EvidenceSource[]; claims: EvidenceClaim[] };
