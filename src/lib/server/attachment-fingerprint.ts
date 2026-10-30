/** Order-sensitive fingerprint of a run's attachments, for idempotent retries (ADR-012). */
export const attachmentFingerprint = (items: { kind: string; contentSha256: string }[]) =>
  items.map(a => `${a.kind}:${a.contentSha256}`).join(",");
