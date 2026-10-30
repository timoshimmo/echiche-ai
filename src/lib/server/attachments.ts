// Reading files and links a user attaches to a question (ADR-012). Server-side only.
//
// - The file type is decided from the bytes (magic numbers and ZIP contents), never from the name or
//   the browser's content type alone.
// - Only extracted text is kept. Images are kept as bytes until the worker reads them with the model;
//   links are read by the worker's SSRF-safe fetcher. The original file is discarded.
// - Hard limits bound memory and CPU: file size, ZIP uncompressed size (zip bombs), PDF pages, and the
//   amount of text kept per attachment.
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import type { AttachmentKind, PreparedAttachment } from "@/lib/domain/types";

export const ATTACHMENT_LIMITS = {
  maxAttachments: 5,
  maxLinks: 3,
  maxImages: 3,
  maxFileBytes: 5 * 1024 * 1024,
  maxImageBytes: 4 * 1024 * 1024,
  /** Whole multipart body: five files at the limit plus the form fields. */
  maxBodyBytes: 26 * 1024 * 1024,
  maxTextChars: 15_000,
  maxZipUncompressedBytes: 40 * 1024 * 1024,
  maxPdfPages: 60,
  maxNameChars: 200
} as const;

export class AttachmentError extends Error {}

const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|json)$/i;
const IMAGE_TYPES: [string, (b: Buffer) => boolean][] = [
  ["image/png", b => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ["image/jpeg", b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/gif", b => b.length > 6 && (b.subarray(0, 6).toString("latin1") === "GIF87a" || b.subarray(0, 6).toString("latin1") === "GIF89a")],
  ["image/webp", b => b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP"]
];

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/** Display name: no path, no control characters, bounded. */
export function cleanName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, ATTACHMENT_LIMITS.maxNameChars);
  return cleaned || "Untitled file";
}

/** Collapses whitespace, drops control characters, and caps the length (reporting truncation). */
export function tidyText(raw: string, max: number = ATTACHMENT_LIMITS.maxTextChars): { text: string; truncated: boolean } {
  const text = raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/ {2,}/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

type ZipEntry = { name: string; uncompressed: number };

/**
 * Lists a ZIP's entries and measures what each really inflates to, within a budget. Sizes declared in
 * the archive can lie, so every entry is actually inflated with a hard output cap (zlib
 * maxOutputLength) before a parser is allowed to touch the file: a zip bomb is refused here, not
 * discovered by running out of memory. Returns null if the bytes are not a ZIP.
 */
export function zipEntries(buf: Buffer, budget: number = ATTACHMENT_LIMITS.maxZipUncompressedBytes): ZipEntry[] | null {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) return null;
  const minEocd = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= minEocd; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (count > 5000) throw new ZipTooLarge();
  const entries: ZipEntry[] = [];
  let remaining = budget;
  for (let n = 0; n < count; n++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(offset + 10);
    const compressed = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const local = buf.readUInt32LE(offset + 42);
    if (offset + 46 + nameLength > buf.length || compressed === 0xffffffff || local === 0xffffffff) return null; // ZIP64: not for Office files this size
    const name = buf.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) return null;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + compressed > buf.length) return null;
    const data = buf.subarray(start, start + compressed);
    let size: number;
    if (method === 0) size = compressed;
    else if (method === 8) {
      try { size = inflateRawSync(data, { maxOutputLength: remaining + 1 }).length; } catch (error) {
        if (error instanceof RangeError) throw new ZipTooLarge();
        return null;
      }
    } else return null;
    remaining -= size;
    if (remaining < 0) throw new ZipTooLarge();
    entries.push({ name, uncompressed: size });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

class ZipTooLarge extends Error {}

/** What the bytes are. Legacy Office (.doc/.xls) and anything unrecognised are refused with a reason. */
export function detectKind(name: string, buf: Buffer): { kind: AttachmentKind; mediaType: string } {
  if (buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-") return { kind: "pdf", mediaType: "application/pdf" };
  for (const [mediaType, test] of IMAGE_TYPES) if (test(buf)) return { kind: "image", mediaType };
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0xd0cf11e0) {
    throw new AttachmentError(`“${name}” is an older Office format. Save it as .docx or .xlsx and try again.`);
  }
  let entries: ZipEntry[] | null;
  try { entries = zipEntries(buf); } catch (error) {
    if (error instanceof ZipTooLarge) throw new AttachmentError(`“${name}” is too large once unpacked.`);
    throw error;
  }
  if (entries === null && buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) {
    throw new AttachmentError(`“${name}” looks damaged and can't be opened.`);
  }
  if (entries) {
    if (entries.some(e => e.name === "word/document.xml")) {
      return { kind: "word", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
    }
    if (entries.some(e => e.name === "xl/workbook.xml")) {
      return { kind: "spreadsheet", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
    }
    throw new AttachmentError(`“${name}” is a ZIP archive Echiche can't read. Attach Word (.docx) or Excel (.xlsx) files directly.`);
  }
  if (TEXT_EXTENSIONS.test(name) && !buf.includes(0)) {
    const ext = name.toLowerCase().split(".").pop();
    const mediaType = ext === "csv" ? "text/csv" : ext === "tsv" ? "text/tab-separated-values" : ext === "json" ? "application/json"
      : ext === "md" || ext === "markdown" ? "text/markdown" : "text/plain";
    return { kind: "text", mediaType };
  }
  throw new AttachmentError(`“${name}” isn't a supported file. Use text, CSV, JSON, PDF, Word (.docx), Excel (.xlsx) or an image (PNG, JPEG, GIF, WebP).`);
}

async function pdfText(buf: Buffer): Promise<{ text: string; pages: number; read: number }> {
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  try {
    const read = Math.min(pdf.numPages, ATTACHMENT_LIMITS.maxPdfPages);
    const pages: string[] = [];
    let length = 0;
    for (let i = 1; i <= read && length < ATTACHMENT_LIMITS.maxTextChars * 2; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map(item => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "")).join("");
      pages.push(text);
      length += text.length;
    }
    return { text: pages.join("\n\n"), pages: pdf.numPages, read };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

async function wordText(buf: Buffer): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer: buf });
  return result.value;
}

type Cell = string | number | boolean | Date | null;
function cell(value: Cell): string {
  if (value === null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).replace(/\s+/g, " ").trim();
}

async function spreadsheetText(buf: Buffer): Promise<string> {
  const { default: readXlsxFile } = await import("read-excel-file/node");
  const sheets = await readXlsxFile(buf);
  const parts: string[] = [];
  let length = 0;
  for (const sheet of sheets) {
    const rows = sheet.data
      .map(row => row.map(v => cell(v as Cell)))
      .filter(row => row.some(v => v !== ""))
      .map(row => row.join("\t"));
    const block = `Sheet: ${sheet.sheet}\n${rows.join("\n")}`;
    parts.push(block);
    length += block.length;
    if (length > ATTACHMENT_LIMITS.maxTextChars * 2) break;
  }
  return parts.join("\n\n");
}

const failed = (base: Omit<PreparedAttachment, "status" | "text" | "truncated" | "imageData" | "note">, note: string): PreparedAttachment =>
  ({ ...base, status: "failed", text: null, truncated: false, imageData: null, note });

/** Reads one uploaded file. Unsupported or oversized files throw (the whole request is refused). */
export async function prepareFile(name: string, buf: Buffer, position: number): Promise<PreparedAttachment> {
  const display = cleanName(name);
  if (buf.length === 0) throw new AttachmentError(`“${display}” is empty.`);
  if (buf.length > ATTACHMENT_LIMITS.maxFileBytes) throw new AttachmentError(`“${display}” is larger than 5 MB.`);
  const { kind, mediaType } = detectKind(display, buf);
  const base = { position, kind, name: display, mediaType, sizeBytes: buf.length, url: null, contentSha256: sha256(buf) };
  if (kind === "image") {
    if (buf.length > ATTACHMENT_LIMITS.maxImageBytes) throw new AttachmentError(`“${display}” is larger than 4 MB. Images must be 4 MB or smaller.`);
    return { ...base, status: "pending", text: null, truncated: false, imageData: buf, note: null };
  }
  try {
    let raw: string;
    let note: string | null = null;
    if (kind === "text") {
      raw = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    } else if (kind === "pdf") {
      const pdf = await pdfText(buf);
      raw = pdf.text;
      if (pdf.read < pdf.pages) note = `Read the first ${pdf.read} of ${pdf.pages} pages.`;
    } else if (kind === "word") {
      raw = await wordText(buf);
    } else {
      raw = await spreadsheetText(buf);
    }
    const { text, truncated } = tidyText(raw);
    if (!text) {
      return failed(base, kind === "pdf"
        ? "No readable text found. It may be a scanned PDF: attach the pages as images instead."
        : "No readable text found in this file.");
    }
    return { ...base, status: "ready", text, truncated, imageData: null, note: note ?? (truncated ? "Only the first part was used (it is long)." : null) };
  } catch (error) {
    if (error instanceof AttachmentError) throw error;
    return failed(base, "Echiche couldn't read this file. It may be damaged or password-protected.");
  }
}

/** A reference link: validated here, read later by the worker (which re-checks it against SSRF rules). */
export function prepareLink(raw: string, position: number): PreparedAttachment {
  const value = raw.trim();
  let url: URL;
  try { url = new URL(value); } catch { throw new AttachmentError(`“${value.slice(0, 80)}” isn't a valid link.`); }
  if (url.protocol !== "https:") throw new AttachmentError("Links must start with https://.");
  if (url.username || url.password) throw new AttachmentError("Links must not contain a user name or password.");
  if (!url.hostname.includes(".") || /^[\d.]+$/.test(url.hostname) || url.hostname.startsWith("[")) {
    throw new AttachmentError(`“${url.hostname}” isn't a public website address.`);
  }
  if (url.port && url.port !== "443") throw new AttachmentError("Links must use the standard https port.");
  url.hash = "";
  const href = url.toString();
  if (href.length > 2048) throw new AttachmentError("That link is too long.");
  const name = `${url.hostname}${url.pathname === "/" ? "" : decodeURI(url.pathname)}`.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, ATTACHMENT_LIMITS.maxNameChars);
  return { position, kind: "link", name, mediaType: null, sizeBytes: 0, url: href, contentSha256: sha256(href),
    status: "pending", text: null, truncated: false, imageData: null, note: null };
}

/** Enforces the per-run counts across files and links. */
export function checkCounts(files: number, links: number, images: number): void {
  const L = ATTACHMENT_LIMITS;
  if (files + links > L.maxAttachments) throw new AttachmentError(`Attach at most ${L.maxAttachments} files and links in total.`);
  if (links > L.maxLinks) throw new AttachmentError(`Add at most ${L.maxLinks} links.`);
  if (images > L.maxImages) throw new AttachmentError(`Attach at most ${L.maxImages} images.`);
}

export { attachmentFingerprint } from "./attachment-fingerprint";
