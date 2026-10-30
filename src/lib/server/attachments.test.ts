import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { AttachmentError, checkCounts, cleanName, detectKind, prepareFile, prepareLink, tidyText, zipEntries } from "./attachments";

/** A one-page PDF with real text, built byte-exactly (correct xref offsets). */
function pdfWith(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

async function docxWith(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function xlsxWith(rows: string[][]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file("xl/workbook.xml", `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`);
  const cols = "ABCDEFGH";
  const xmlRows = rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => `<c r="${cols[j]}${i + 1}" t="inlineStr"><is><t>${v}</t></is></c>`).join("")}</row>`).join("");
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${xmlRows}</sheetData></worksheet>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4e00000000049454e44ae426082", "hex");

describe("attachments: reading files on the server (ADR-012)", () => {
  it("reads text, PDF, Word and Excel files into text", async () => {
    const text = await prepareFile("notes.md", Buffer.from("# Plan\n\nHire   two engineers.\r\n"), 1);
    expect(text).toMatchObject({ kind: "text", status: "ready", text: "# Plan\n\nHire two engineers.", truncated: false });
    const pdf = await prepareFile("report.pdf", pdfWith("Runway is 14 months"), 2);
    expect(pdf).toMatchObject({ kind: "pdf", status: "ready" });
    expect(pdf.text).toContain("Runway is 14 months");
    const word = await prepareFile("memo.docx", await docxWith("Customers want local support"), 3);
    expect(word).toMatchObject({ kind: "word", status: "ready", text: "Customers want local support" });
    const sheet = await prepareFile("budget.xlsx", await xlsxWith([["Item", "Cost"], ["Rent", "1200"]]), 4);
    expect(sheet).toMatchObject({ kind: "spreadsheet", status: "ready" });
    expect(sheet.text).toBe("Sheet: Budget\nItem\tCost\nRent\t1200");
    for (const a of [text, pdf, word, sheet]) expect(a.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps images as bytes for the worker to read, and checks the type from the bytes, not the name", async () => {
    const image = await prepareFile("whiteboard.png", PNG, 1);
    expect(image).toMatchObject({ kind: "image", status: "pending", mediaType: "image/png", text: null });
    expect(image.imageData?.equals(PNG)).toBe(true);
    // A renamed binary is not accepted as text, and a PNG named .txt is still an image.
    await expect(prepareFile("evil.txt", Buffer.from([0x00, 0x01, 0x02, 0x41]), 1)).rejects.toThrow(AttachmentError);
    expect((await prepareFile("photo.txt", PNG, 1)).kind).toBe("image");
  });

  it("refuses unsupported, legacy, empty and oversized files with a plain reason", async () => {
    await expect(prepareFile("old.doc", Buffer.from("d0cf11e0a1b11ae1" + "00".repeat(16), "hex"), 1)).rejects.toThrow(/older Office format/);
    await expect(prepareFile("program.exe", Buffer.from("MZ\x90\x00"), 1)).rejects.toThrow(/isn't a supported file/);
    await expect(prepareFile("empty.txt", Buffer.alloc(0), 1)).rejects.toThrow(/empty/);
    await expect(prepareFile("big.txt", Buffer.alloc(5 * 1024 * 1024 + 1, 0x41), 1)).rejects.toThrow(/larger than 5 MB/);
    const zip = new JSZip(); zip.file("a.txt", "x");
    await expect(prepareFile("archive.zip", await zip.generateAsync({ type: "nodebuffer" }), 1)).rejects.toThrow(/ZIP archive/);
  });

  it("refuses zip bombs from the declared sizes, before anything is inflated", async () => {
    const zip = new JSZip();
    zip.file("word/document.xml", "a".repeat(41 * 1024 * 1024));
    const bomb = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    expect(bomb.length).toBeLessThan(1024 * 1024);
    expect(() => detectKind("bomb.docx", bomb)).toThrow(/too large once unpacked/);
    // Measured by inflating (with a cap), not taken from the sizes the archive declares.
    expect(zipEntries(bomb, 50 * 1024 * 1024)?.find(e => e.name === "word/document.xml")?.uncompressed).toBe(41 * 1024 * 1024);
  });

  it("reports unreadable content as failed with a note, instead of failing the run", async () => {
    const blank = await prepareFile("scan.pdf", pdfWith(""), 1);
    expect(blank).toMatchObject({ status: "failed", text: null });
    expect(blank.note).toMatch(/scanned PDF/);
    const broken = await prepareFile("broken.docx", Buffer.concat([await docxWith("x")]).subarray(0, 60), 1).catch(e => e);
    expect(broken instanceof AttachmentError || broken.status === "failed").toBe(true);
  });

  it("caps text per attachment and says so", () => {
    expect(tidyText("a".repeat(20_000))).toEqual({ text: "a".repeat(15_000), truncated: true });
    expect(cleanName("../../etc/passwd\u0007")).toBe("passwd");
    expect(cleanName("")).toBe("Untitled file");
  });

  it("accepts only public https links and leaves reading them to the worker", () => {
    const link = prepareLink("https://example.org/report?id=1#section", 3);
    expect(link).toMatchObject({ kind: "link", status: "pending", url: "https://example.org/report?id=1", name: "example.org/report", position: 3 });
    for (const bad of ["http://example.org", "https://localhost/x", "https://10.0.0.1/", "https://[::1]/", "https://user:pw@example.org/",
      "https://example.org:8443/", "ftp://example.org", "not a url"]) {
      expect(() => prepareLink(bad, 1), bad).toThrow(AttachmentError);
    }
  });

  it("limits how many files, links and images one question can carry", () => {
    expect(() => checkCounts(3, 2, 1)).not.toThrow();
    expect(() => checkCounts(4, 2, 0)).toThrow(/at most 5/);
    expect(() => checkCounts(1, 4, 0)).toThrow(/at most 5|at most 3 links/);
    expect(() => checkCounts(4, 0, 4)).toThrow(/at most 3 images/);
  });
});
