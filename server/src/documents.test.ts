import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { Store } from "./store.js";
import { saveDocument, recognizeLocal, sniff } from "./documents.js";

test("recognizes actual image pixels locally and rejects disguised uploads", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "freeocrapi-ocr-"));
  const store = new Store(directory);
  try {
    const canvas = createCanvas(1100, 200);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, 1100, 200);
    ctx.fillStyle = "#000";
    ctx.font = "60px Arial";
    ctx.fillText("FREE OCR API 2026", 40, 125);
    const file = await saveDocument(
      store,
      "../../sample.png",
      canvas.toBuffer("image/png"),
    );
    expect(file.name).toBe("sample.png");
    expect(file.pages).toBe(1);
    const result = await recognizeLocal(store, file, {});
    expect(result.text).toContain("2026");
    expect(result.text).toMatch(/FREE\s+OCR/i);
    expect(result.pages[0].blocks.length).toBeGreaterThan(0);
    expect(() => sniff(Buffer.from("<script>alert(1)</script>"))).toThrow();
    await expect(recognizeLocal(store, file, { pages: [2] })).rejects.toThrow(
      "Page selection",
    );
  } finally {
    store.close();
    if (
      path.dirname(directory) !== tmpdir() ||
      !path.basename(directory).startsWith("freeocrapi-ocr-")
    )
      throw new Error("Unsafe cleanup");
    rmSync(directory, { recursive: true, force: true });
  }
}, 60000);

function twoPagePdf() {
  const stream = (text: string) => {
    const content = `BT /F1 30 Tf 45 130 Td (${text}) Tj ET`;
    return `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`;
  };
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 220] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
    stream("FREE OCR API 2026"),
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 220] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
    stream("SECOND PAGE 2027"),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let content = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(content));
    content += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(content);
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
    .join(
      "",
    )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(content);
}
test("rasterizes a multipage PDF and preserves recognized page order", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "freeocrapi-ocr-"));
  const store = new Store(directory);
  try {
    const file = await saveDocument(store, "two-pages.pdf", twoPagePdf());
    expect(file.pages).toBe(2);
    const result = await recognizeLocal(store, file, {});
    expect(result.pages.map((p) => p.number)).toEqual([1, 2]);
    expect(result.pages[0].text).toContain("2026");
    expect(result.pages[1].text).toContain("2027");
  } finally {
    store.close();
    if (
      path.dirname(directory) !== tmpdir() ||
      !path.basename(directory).startsWith("freeocrapi-ocr-")
    )
      throw new Error("Unsafe cleanup");
    rmSync(directory, { recursive: true, force: true });
  }
}, 60000);
