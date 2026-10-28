// Source-backed repository figures. Run after pnpm build.
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { catalog } from "../server/dist/catalog.js";

const directory = new URL("../repo-assets/", import.meta.url);
await mkdir(directory, { recursive: true });
const escape = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;");
const text = (x, y, value, size = 20, fill = "#a6a6ad", weight = 400) =>
  `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-weight="${weight}">${escape(value)}</text>`;
const box = (x, y, w, h) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="20" fill="#151518" stroke="#303036"/>`;
async function figure(name, title, subtitle, height, content) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${height}" viewBox="0 0 1200 ${height}" role="img" aria-label="${escape(title)}"><title>${escape(title)}</title><desc>${escape(subtitle)}</desc><rect width="1200" height="${height}" rx="28" fill="#0b0b0d"/><g font-family="Arial,Helvetica,sans-serif">${text(44, 51, "freeOCRAPI / LOCAL-FIRST DOCUMENT PROCESSING", 14, "#8b8b94", 600)}${text(44, 108, title, 36, "#fafafa", 700)}${text(44, 146, subtitle, 18)}${content}</g></svg>\n`;
  await writeFile(new URL(name, directory), svg);
}
const local = catalog.filter((engine) => engine.local);
const cloud = catalog.filter(
  (engine) => !engine.local && engine.id !== "custom",
);
const formats = [...new Set(catalog.flatMap((engine) => engine.formats))];
await figure(
  "overview.svg",
  "Your documents. One OCR gateway.",
  "Run locally. Add providers when you need them. Keep every result traceable.",
  405,
  [
    [catalog.length, "ADAPTERS"],
    [formats.length, "INPUT FORMATS"],
    [4, "EXPORT FORMATS"],
    [1, "ENGINE PER DOCUMENT"],
  ]
    .map(([value, label], i) => {
      const x = 44 + i * 284;
      return (
        box(x, 190, 260, 145) +
        text(x + 24, 260, value, 54, "#ffffff", 700) +
        text(x + 24, 305, label, 14, "#b8b8c0", 600)
      );
    })
    .join("") +
    text(
      44,
      374,
      "Default upload: 50 MB / 100 pages  ·  Built-in English Tesseract runs offline",
      17,
    ),
);
await figure(
  "providers.svg",
  "Choose where recognition happens.",
  "10 implemented adapters. Formats and capabilities depend on the configured engine.",
  520,
  [
    [
      `${local.length} local options`,
      [
        "Tesseract — built in",
        "PaddleOCR — optional service",
        "Docling — optional service",
      ],
      "Built-in verified; sidecar runtime checks pending.",
    ],
    [
      `${cloud.length} cloud adapters`,
      cloud.map((engine) =>
        engine.id === "azure"
          ? "Azure Document Intelligence"
          : engine.id === "google"
            ? "Google Document AI"
            : engine.name,
      ),
      "Fixtures; live accounts not verified.",
    ],
    [
      "1 custom contract",
      ["Your HTTP(S) OCR endpoint", "POST /ocr", "Normalized page results"],
      "Connect a service you control.",
    ],
  ]
    .map(([title, lines, note], i) => {
      const x = 44 + i * 378;
      return (
        box(x, 184, 356, 286) +
        text(x + 22, 224, title, 24, "#ffffff", 700) +
        lines.map((line, j) => text(x + 22, 262 + j * 28, line, 17)).join("") +
        text(x + 22, 448, note, 12)
      );
    })
    .join(""),
);
await figure(
  "features.svg",
  "A local document workflow.",
  "Capabilities are explicit. Missing confidence, quota and usage values remain unknown.",
  510,
  [
    [
      "01 / INGEST",
      "PDF, PNG, JPEG, WebP, TIFF",
      "Local preprocessing and page selection",
    ],
    [
      "02 / ROUTE",
      "One engine; sequential safe failover",
      "Persisted jobs and provider operations",
    ],
    [
      "03 / EXPORT",
      "Text, Markdown, JSON and table CSV",
      "Page provenance and result inspection",
    ],
    [
      "04 / PROTECT",
      "AES-256-GCM provider credentials",
      "Bearer API key; separate admin session",
    ],
    [
      "05 / INTEGRATE",
      "REST, MCP, CLI and Python",
      "LlamaIndex / LangChain / Haystack",
    ],
    [
      "06 / OPERATE",
      "Encrypted backups and retention",
      "Optional caps, cache and health status",
    ],
  ]
    .map(([title, a, b], i) => {
      const x = 44 + (i % 3) * 378,
        y = 184 + Math.floor(i / 3) * 148;
      return (
        box(x, y, 356, 126) +
        text(x + 20, y + 32, title, 15, "#ffffff", 700) +
        text(x + 20, y + 66, a, 16) +
        text(x + 20, y + 94, b, 15)
      );
    })
    .join(""),
);
const columns = [
  ["Built-in", "Tesseract", "Local", "Included", "Real OCR tested"],
  [
    "Self-hosted",
    "PaddleOCR / Docling",
    "Your service",
    "Deploy sidecar",
    "Runtime checks pending",
  ],
  [
    "Cloud",
    "6 provider adapters",
    "Provider service",
    "Your credentials",
    "Live checks pending",
  ],
  [
    "Custom",
    "Your /ocr endpoint",
    "Your endpoint",
    "Adapter contract",
    "Service-specific",
  ],
];
await figure(
  "comparison.svg",
  "Pick the execution model that fits.",
  "An implementation comparison within freeOCRAPI; provider plan limits and charges vary.",
  490,
  columns
    .map(([title, ...lines], i) => {
      const x = 44 + i * 284;
      return (
        box(x, 184, 260, 250) +
        text(x + 20, 225, title, 24, "#ffffff", 700) +
        lines.map((line, j) => text(x + 20, 270 + j * 40, line, 16)).join("")
      );
    })
    .join("") +
    text(
      44,
      467,
      "No shared free-page total or accuracy benchmark is claimed. Tesseract needs no provider key.",
      15,
    ),
);
await figure(
  "verification.svg",
  "Measured checks. Visible limits.",
  "Windows x64 snapshot — 28 October 2026. Exact commands are in VERIFICATION.md.",
  390,
  [
    ["35 + 2", "JavaScript/TypeScript + Python tests"],
    ["37", "Application/runtime files matched per package"],
    ["2", "Windows downloads: installer + portable ZIP"],
  ]
    .map(([value, label], i) => {
      const x = 44 + i * 378;
      return (
        box(x, 184, 356, 145) +
        text(x + 22, 247, value, 46, "#ffffff", 700) +
        text(x + 22, 292, label, 13)
      );
    })
    .join("") +
    text(
      44,
      366,
      "Desktop boot and packaged OCR passed. Cloud, Docker runtime and macOS/Linux checks remain open.",
      15,
    ),
);
await copyFile(
  new URL("../artifacts/ocr-result.png", import.meta.url),
  new URL("ocr-result.png", directory),
);
console.log(
  "Generated five OCR-specific figures and copied the verified OCR screenshot.",
);
