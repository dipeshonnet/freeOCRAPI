import { createRequire } from "node:module";
import path from "node:path";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  copyFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createWorker } from "tesseract.js";
import type { OcrOptions, OcrPage, OcrResult } from "../../shared/types.js";
import { Store, hash } from "./store.js";
import { AppError } from "./errors.js";

const require = createRequire(import.meta.url);
const modelDir = path.join(
  path.dirname(require.resolve("@tesseract.js-data/eng/package.json")),
  "4.0.0",
);
export function localReady() {
  return existsSync(path.join(modelDir, "eng.traineddata.gz"));
}
export interface FileRecord {
  id: string;
  name: string;
  mime: string;
  format: string;
  size: number;
  pages: number;
  sha256: string;
  created_at: string;
}
export const filePath = (store: Store, id: string) =>
  path.join(store.dataDir, "files", id);
export function getFile(store: Store, id: string) {
  const row = store.db
    .prepare("SELECT * FROM files WHERE id=?")
    .get(id) as unknown as FileRecord | undefined;
  if (!row) throw new AppError(404, "Document not found.");
  return row;
}
export function sniff(data: Buffer) {
  if (data.subarray(0, 5).toString() === "%PDF-")
    return { format: "pdf", mime: "application/pdf" };
  if (
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return { format: "png", mime: "image/png" };
  if (data[0] === 255 && data[1] === 216 && data[2] === 255)
    return { format: "jpeg", mime: "image/jpeg" };
  if (["49492a00", "4d4d002a"].includes(data.subarray(0, 4).toString("hex")))
    return { format: "tiff", mime: "image/tiff" };
  if (
    data.subarray(0, 4).toString() === "RIFF" &&
    data.subarray(8, 12).toString() === "WEBP"
  )
    return { format: "webp", mime: "image/webp" };
  throw new AppError(415, "Upload a PDF, PNG, JPEG, WebP or TIFF document.");
}
function pdf(data: Buffer) {
  return getDocument({
    data: new Uint8Array(data),
    useSystemFonts: true,
    useWorkerFetch: false,
  });
}
export async function saveDocument(store: Store, name: string, data: Buffer) {
  const prefs = store.setting<{ maxFileMB: number; maxPages: number }>(
    "preferences",
  )!;
  if (!data.length || data.length > prefs.maxFileMB * 1024 * 1024)
    throw new AppError(
      413,
      `Document must be between 1 byte and ${prefs.maxFileMB} MB.`,
    );
  const detected = sniff(data);
  let pages: number;
  try {
    if (detected.format === "pdf") {
      const task = pdf(data);
      try {
        const document = await task.promise;
        pages = document.numPages;
      } finally {
        await task.destroy();
      }
    } else {
      const metadata = await sharp(data, {
        limitInputPixels: 40_000_000,
      }).metadata();
      pages = metadata.pages || 1;
    }
  } catch {
    throw new AppError(
      400,
      "The document is corrupt, password-protected or too large to decode.",
    );
  }
  if (pages > prefs.maxPages)
    throw new AppError(
      413,
      `Document exceeds the ${prefs.maxPages}-page limit.`,
    );
  const id = randomUUID();
  const safeName =
    path
      .basename(name.replace(/\\/g, "/"))
      .replace(/[\x00-\x1f]/g, "")
      .slice(0, 200) || `document.${detected.format}`;
  mkdirSync(path.join(store.dataDir, "files"), { recursive: true });
  writeFileSync(filePath(store, id), data, { mode: 0o600, flag: "wx" });
  store.db
    .prepare("INSERT INTO files VALUES(?,?,?,?,?,?,?,?)")
    .run(
      id,
      safeName,
      detected.mime,
      detected.format,
      data.length,
      pages,
      hash(data),
      new Date().toISOString(),
    );
  return getFile(store, id);
}
export async function* documentImages(
  store: Store,
  file: FileRecord,
  options: OcrOptions,
) {
  const data = readFileSync(filePath(store, file.id));
  const wanted = options.pages?.length
    ? [...new Set(options.pages)].sort((a, b) => a - b)
    : Array.from({ length: file.pages }, (_, i) => i + 1);
  if (wanted.some((p) => !Number.isInteger(p) || p < 1 || p > file.pages))
    throw new AppError(400, "Page selection is outside the document.");
  const task = file.format === "pdf" ? pdf(data) : undefined;
  const document = task ? await task.promise : undefined;
  try {
    for (const number of wanted) {
      let image: Buffer;
      if (document) {
        const page = await document.getPage(number);
        const raw = page.getViewport({ scale: 1 });
        const scale = Math.min(
          2,
          Math.sqrt(25_000_000 / (raw.width * raw.height)),
        );
        const viewport = page.getViewport({ scale });
        const canvas = createCanvas(
          Math.ceil(viewport.width),
          Math.ceil(viewport.height),
        );
        await page.render({
          canvasContext: canvas.getContext("2d") as never,
          viewport,
          canvas: canvas as never,
        }).promise;
        image = canvas.toBuffer("image/png");
        page.cleanup();
      } else
        image = await sharp(data, {
          page: number - 1,
          pages: 1,
          limitInputPixels: 40_000_000,
        })
          .png()
          .toBuffer();
      let processed = sharp(image).rotate(options.rotate || undefined);
      if (options.grayscale) processed = processed.grayscale();
      if (options.threshold) processed = processed.threshold();
      yield { number, data: await processed.png().toBuffer() };
    }
  } finally {
    await task?.destroy();
  }
}
export async function recognizeLocal(
  store: Store,
  file: FileRecord,
  options: OcrOptions,
  signal?: AbortSignal,
  progress?: (page: number) => void,
): Promise<OcrResult> {
  const language =
    options.language ||
    store.setting<{ defaultLanguage: string }>("preferences")!.defaultLanguage;
  const languageDir =
    language === "eng" ? modelDir : path.join(store.dataDir, "languages");
  if (language !== "eng" && language.split("+").includes("eng")) {
    mkdirSync(languageDir, { recursive: true });
    if (!existsSync(path.join(languageDir, "eng.traineddata.gz")))
      copyFileSync(
        path.join(modelDir, "eng.traineddata.gz"),
        path.join(languageDir, "eng.traineddata.gz"),
      );
  }
  for (const code of language.split("+"))
    if (!existsSync(path.join(languageDir, `${code}.traineddata.gz`)))
      throw new AppError(
        400,
        `Language '${code}' is not installed. Install its language pack first.`,
      );
  if (signal?.aborted) throw new AppError(409, "Processing was cancelled.");
  const worker = await createWorker(language, 1, {
    langPath: languageDir,
    cacheMethod: "none",
    gzip: true,
  });
  const abort = () => {
    void worker.terminate().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  const pages: OcrPage[] = [];
  try {
    for await (const image of documentImages(store, file, options)) {
      if (signal?.aborted) throw new AppError(409, "Processing was cancelled.");
      const { data } = await worker.recognize(
        image.data,
        {},
        { text: true, blocks: true },
      );
      const metadata = await sharp(image.data).metadata();
      pages.push({
        number: image.number,
        text: data.text,
        markdown: data.text,
        width: metadata.width,
        height: metadata.height,
        confidence: Number.isFinite(data.confidence)
          ? data.confidence / 100
          : null,
        tables: [],
        blocks: (data.blocks || []).flatMap((block) =>
          block.paragraphs.flatMap((paragraph) =>
            paragraph.lines.map((line) => ({
              text: line.text,
              confidence: line.confidence / 100,
              bbox: [
                line.bbox.x0,
                line.bbox.y0,
                line.bbox.x1,
                line.bbox.y1,
              ] as [number, number, number, number],
            })),
          ),
        ),
      });
      progress?.(pages.length);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    await worker.terminate().catch(() => {});
  }
  return {
    engine: "tesseract",
    provider: "Local",
    pages,
    text: pages.map((p) => p.text).join("\n\n"),
    markdown: pages.map((p) => p.markdown).join("\n\n---\n\n"),
    usage: { pages: pages.length, credits: null },
  };
}
