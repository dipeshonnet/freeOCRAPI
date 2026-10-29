// Source-backed repository figures. Run after pnpm build.
import { mkdir, writeFile, copyFile, readFile } from "node:fs/promises";
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
const allowances = JSON.parse(
  await readFile(
    new URL("../docs/free-allowances.json", import.meta.url),
    "utf8",
  ),
);
if (
  allowances.providers.length !== catalog.length ||
  new Set(allowances.providers.map((provider) => provider.id)).size !==
    catalog.length ||
  catalog.some(
    (engine) =>
      !allowances.providers.some((provider) => provider.id === engine.id),
  )
)
  throw new Error(
    "Allowance snapshot must cover each catalog adapter exactly once.",
  );
const monthlyPages = (provider, pagesPerRequest = 1) => {
  if (provider.kind === "recurring_credits")
    return Math.floor(provider.monthlyCredits / provider.creditsPerPage);
  if (provider.kind === "recurring_pages") return provider.monthlyPages;
  if (provider.kind === "recurring_requests")
    return (
      Math.min(
        provider.monthlyRequests,
        provider.requestsPerDayPerIp * allowances.planningDays,
      ) * pagesPerRequest
    );
  return null;
};
const recurring = allowances.providers.filter(
  (provider) => monthlyPages(provider) !== null,
);
const baseline = recurring.reduce(
  (total, provider) => total + monthlyPages(provider),
  0,
);
const barMaximum = Math.max(
  ...recurring.map((provider) => monthlyPages(provider)),
);
const packedPdf = recurring.reduce(
  (total, provider) =>
    total + monthlyPages(provider, provider.maxPdfPagesPerRequest || 1),
  0,
);
const trial = allowances.providers.find(
  (provider) => provider.id === "textract",
).textPagesPerMonth;
const number = (value) => value.toLocaleString("en-US");
await figure(
  "free-allowances.svg",
  "Quantified free-tier planning capacity",
  `Checked ${allowances.checkedOn} · ${allowances.planningDays}-day scenarios · eligible accounts required; not live balances`,
  790,
  [
    [
      number(baseline),
      "SINGLE-PAGE EQUIVALENTS",
      "Four quantified recurring cloud allowances",
    ],
    [
      number(packedPdf),
      "PACKED-PDF PAGE CEILING",
      "Every OCR.space request: 3 PDF pages / 1 MB",
    ],
    [
      `+${number(trial)}`,
      "TEXTRACT PAGES / MONTH",
      "Eligible new customers, first 3 months only",
    ],
  ]
    .map(([value, label, note], i) => {
      const x = 44 + i * 378;
      return (
        box(x, 183, 356, 150) +
        text(x + 20, 243, value, 46, "#fff", 700) +
        text(x + 20, 282, label, 13, "#d4d4db", 600) +
        text(x + 20, 311, note, 12)
      );
    })
    .join("") +
    text(
      44,
      378,
      "Single-page equivalents per 30-day planning month",
      20,
      "#fff",
      600,
    ) +
    recurring
      .map((provider, i) => {
        const value = monthlyPages(provider),
          y = 420 + i * 56;
        return (
          text(44, y + 20, provider.name, 16) +
          `<rect x="285" y="${y}" width="${(value / barMaximum) * 735}" height="28" rx="5" fill="#bcbcc7"/>` +
          text(1044, y + 21, number(value), 16, "#fff", 600)
        );
      })
      .join("") +
    text(
      44,
      677,
      "LlamaParse Fast: 1 credit/page. OCR.space: min(25,000/month, 500/day × 30) requests.",
      16,
    ) +
    text(
      44,
      710,
      "3 self-hosted engines: no provider credit meter; hardware limits/costs apply. Mistral/custom: unquantified.",
      15,
    ) +
    text(
      44,
      743,
      "Independent quotas, not one shared credit pool. Sources, limits and scenario calculations are in the README.",
      15,
    ),
);
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
      "Free-tier planning scenarios are documented separately. Tesseract needs no provider key.",
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
  `Generated six OCR-specific figures; recurring baseline ${number(baseline)}, packed-PDF ceiling ${number(packedPdf)}, trial increment ${number(trial)}.`,
);
