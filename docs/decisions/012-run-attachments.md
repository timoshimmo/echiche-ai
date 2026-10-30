# ADR-012: Files and links attached to a question

- Status: **Accepted** (2026-10-30). Requested by the decision owner: attach text, PDF, Word, spreadsheets/Excel, images and reference links; Echiche reads them to think the question through, without displaying their content.
- Decision owner: Tokmang
- Related: ADR-007 (prompts and injection boundary), ADR-008 (fetcher), ADR-010 (routing and budgets), ADR-011 (spend ceilings)

## Decision
1. **Per question, not per project.** Attachments belong to one run (`echiche.run_attachments`, migration 0010) and are deleted with it, its project or the account.
2. **Read on the right side of the trust boundary.**

   | Kind | Read by | How |
   |---|---|---|
   | Text, Markdown, CSV/TSV, JSON | web app, when the run is queued | UTF-8 decode |
   | PDF | web app | `unpdf` (pdf.js), first 60 pages, text layer only |
   | Word (.docx) | web app | `mammoth` raw text |
   | Excel (.xlsx) | web app | `read-excel-file`, every sheet as tab-separated rows |
   | Images (PNG, JPEG, GIF, WebP) | worker, at the start of planning | the model, through the `attachment-reader` prompt (image input) |
   | https links | worker, at the start of planning | the research `PageFetcher` (SSRF guard, robots.txt, publisher opt-outs, size limits) |

   The type is decided from the bytes (magic numbers, ZIP contents), not the file name. Legacy `.doc`/`.xls`, archives and executables are refused with a reason. Office files are inflated with a hard output cap before parsing (zip bombs), whatever sizes the archive declares.
3. **Only text is kept.** The original file is discarded after extraction; image bytes are cleared once the worker has read them. Per attachment at most 15,000 characters, per run 30,000 (the rest is marked truncated, and the brief says so).
4. **Model input, never display.** Attachment text reaches the framing, critique and synthesis prompts as a fenced `attachments_json` block (refs A1…A5), treated as untrusted user-supplied data. It never appears in the UI, logs, events or stage checkpoints. The UI shows names, kinds, sizes and reading status; the project export includes the extracted text (the user's own data), not image bytes.
5. **Not evidence.** Attachments can never be cited as sources (the citation guard admits only verified research source IDs). Briefs refer to them by name and label points taken from them as user-provided.
6. **Budget.** Attachments add input to every model call, so a run with attachments is at least Standard (route reason `attachments`); the escalation preflight is sized from the real synthesis request.
7. **Links in the question text** (https://…, http://… upgraded to https, or www.…) are attached and read like links added with "Add link", and so is a link left in the link field without pressing "Add link" (2026-10-31). The form says which links it found; any beyond the 3-link limit are named as not read.
8. **Limits.** 5 attachments (≤3 links, ≤3 images), files ≤5 MB (images ≤4 MB), multipart body ≤26 MB, declared by Content-Length; multipart requests must carry the app's Origin.

## Consequences
- Three new runtime dependencies on the web app (MIT/BSD, pinned): `unpdf@1.8.1`, `mammoth@1.13.0`, `read-excel-file@9.3.12`. `npm audit` clean.
- Prompt versions: `decision-framing@2.2.0`, `decision-critic@2.2.0`, `decision-brief-synthesis@2.4.0`; new `attachment-reader@1.0.0` bound to `attachment-reading.v1`.
- Demo mode stores attachments but cannot use them; images and links are marked "not read", and the result says so.
- Scanned PDFs have no text layer; the user is told to attach the pages as images.
- Not done: OCR of scanned PDFs, reading PDFs or documents behind links (only web pages), password-protected files, attachments that persist across runs (a project document library). Each is a possible follow-up.
- The privacy notice (draft) and `docs/security/data-lifecycle.md` describe who receives attachment content.
