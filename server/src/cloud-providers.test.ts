import { expect, test, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { providers, type ProviderContext } from "./providers.js";
import {
  normalizeMistral,
  normalizeSpace,
  normalizeAzure,
  normalizeGoogle,
  normalizeTextract,
  normalizePaddle,
  serviceUrl,
  markdownRows,
} from "./cloud-providers.js";

test.each([undefined, "1"])(
  "REST result limit stops streaming with content-length %s and never permits fallback",
  async (length) => {
    const directory = mkdtempSync(path.join(tmpdir(), "freeocrapi-response-"));
    mkdirSync(path.join(directory, "files"));
    writeFileSync(path.join(directory, "files", "fixture"), "fixture pixels");
    let pulls = 0,
      cancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(16 * 1024 * 1024));
          if (pulls === 4) controller.close();
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(stream, {
        headers: length ? { "Content-Length": length } : {},
      }),
    );
    try {
      const context = {
        store: { dataDir: directory, setting: () => undefined },
        file: {
          id: "fixture",
          name: "fixture.png",
          mime: "image/png",
          format: "png",
        },
        secret: { apiKey: "fixture-only" },
        options: {},
        signal: new AbortController().signal,
        onOperation: () => {},
        progress: () => {},
      } as unknown as ProviderContext;
      await expect(providers.get("mistral")!(context)).rejects.toMatchObject({
        message: "Provider result exceeds the response size limit.",
        safeToFallback: false,
      });
      expect(pulls).toBe(2);
      expect(cancelled).toBe(true);
    } finally {
      fetchMock.mockRestore();
      if (
        path.dirname(directory) !== tmpdir() ||
        !path.basename(directory).startsWith("freeocrapi-response-")
      )
        throw new Error("Unsafe cleanup path");
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
test("Mistral preserves zero-based provider page provenance and missing confidence", () => {
  const r = normalizeMistral({
    pages: [
      {
        index: 2,
        markdown: "third page",
        dimensions: { width: 600, height: 800 },
      },
    ],
  });
  expect(r.pages[0].number).toBe(3);
  expect(r.pages[0].confidence).toBeNull();
  expect(r.usage.credits).toBeNull();
});
test("OCR.space preserves overlay geometry and terminal document errors", () => {
  const r = normalizeSpace({
    ParsedResults: [
      {
        ParsedText: "Hello",
        TextOverlay: {
          Lines: [
            {
              LineText: "Hello",
              MinTop: 3,
              MaxHeight: 10,
              Words: [{ Left: 2, Width: 20 }],
            },
          ],
        },
      },
    ],
  });
  expect(r.pages[0].blocks[0].bbox).toEqual([2, 3, 22, 13]);
  expect(() => normalizeSpace({ IsErroredOnProcessing: true })).toThrow();
});
test("Azure preserves table cells and structured fields", () => {
  const r = normalizeAzure({
    analyzeResult: {
      pages: [{ pageNumber: 1, lines: [{ content: "Invoice" }] }],
      tables: [
        {
          rowCount: 1,
          columnCount: 2,
          boundingRegions: [{ pageNumber: 1 }],
          cells: [
            { rowIndex: 0, columnIndex: 0, content: "Total" },
            { rowIndex: 0, columnIndex: 1, content: "100" },
          ],
        },
      ],
      documents: [{ fields: { total: { valueNumber: 100 } } }],
    },
  });
  expect(r.pages[0].tables[0].rows).toEqual([["Total", "100"]]);
  expect(r.pages[0].fields).toHaveProperty("total");
});
test("Google reconstructs text anchors without losing page boundaries", () => {
  const r = normalizeGoogle({
    document: {
      text: "FirstSecond",
      pages: [
        {
          pageNumber: 1,
          layout: { textAnchor: { textSegments: [{ endIndex: 5 }] } },
        },
        {
          pageNumber: 2,
          layout: {
            textAnchor: { textSegments: [{ startIndex: 5, endIndex: 11 }] },
          },
        },
      ],
    },
  });
  expect(r.pages.map((p) => p.text)).toEqual(["First", "Second"]);
});
test("Textract merges paginated block records into ordered pages", () => {
  const r = normalizeTextract([
    { Id: "a", Page: 2, BlockType: "LINE", Text: "Second", Confidence: 90 },
    { Id: "b", Page: 1, BlockType: "LINE", Text: "First" },
  ]);
  expect(r.pages.map((p) => p.number)).toEqual([1, 2]);
  expect(r.pages[0].blocks[0].confidence).toBeNull();
  expect(r.text).toBe("First\n\nSecond");
});
test("Paddle normalizes polygons and recognition confidence", () => {
  const r = normalizePaddle({
    result: {
      ocrResults: [
        {
          prunedResult: {
            page_index: 0,
            rec_texts: ["Local OCR"],
            rec_scores: [0.9],
            rec_polys: [
              [
                [1, 2],
                [10, 2],
                [10, 20],
                [1, 20],
              ],
            ],
          },
        },
      ],
    },
  });
  expect(r.pages[0].blocks[0].bbox).toEqual([1, 2, 10, 20]);
  expect(r.pages[0].blocks[0].confidence).toBe(0.9);
});
test("service configuration rejects embedded credentials and tables skip separator rows", () => {
  expect(serviceUrl("http://127.0.0.1:5001", "/ocr")).toBe(
    "http://127.0.0.1:5001/ocr",
  );
  expect(() =>
    serviceUrl("https://user:password@example.com", "/ocr"),
  ).toThrow();
  expect(markdownRows("| A | B |\n|---|---|\n| 1 | 2 |")).toEqual([
    ["A", "B"],
    ["1", "2"],
  ]);
});
