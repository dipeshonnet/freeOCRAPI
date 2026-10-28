import { readFileSync, createReadStream } from "node:fs";
import { createSign, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import LlamaCloud from "@llamaindex/llama-cloud";
import {
  TextractClient,
  StartDocumentAnalysisCommand,
  StartDocumentTextDetectionCommand,
  GetDocumentAnalysisCommand,
  GetDocumentTextDetectionCommand,
  type Block,
} from "@aws-sdk/client-textract";
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { filePath } from "./documents.js";
import { ProviderError, type ProviderContext, providers } from "./providers.js";
import type { OcrPage, OcrResult } from "../../shared/types.js";
import { dispatcher, readLimitedBody, ResponseLimitError } from "./network.js";

// Provider wire formats are validated at their normalization boundary.
type Wire = Record<string, any>;
const bytes = (c: ProviderContext) =>
  readFileSync(filePath(c.store, c.file.id));
const blob = (c: ProviderContext) =>
  new Blob([new Uint8Array(bytes(c))], { type: c.file.mime });
export function serviceUrl(base: string, route: string) {
  const url = new URL(base);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new ProviderError(
      "Configure an HTTP(S) service base URL without credentials, query or fragment.",
      true,
    );
  return `${url.toString().replace(/\/$/, "")}${route}`;
}
export function normalized(
  engine: string,
  provider: string,
  pages: OcrPage[],
  credits: number | null = null,
): OcrResult {
  if (
    pages.some((p) => !Number.isInteger(p.number) || p.number < 1) ||
    new Set(pages.map((p) => p.number)).size !== pages.length
  )
    throw new ProviderError(
      "Provider returned invalid or duplicate page numbers.",
      true,
    );
  if (!pages.length)
    throw new ProviderError("The provider returned no page results.", true);
  return {
    engine,
    provider,
    pages: pages.sort((a, b) => a.number - b.number),
    text: pages.map((p) => p.text).join("\n\n"),
    markdown: pages.map((p) => p.markdown).join("\n\n---\n\n"),
    usage: { pages: pages.length, credits },
  };
}
const page = (
  number: number,
  text: string,
  extra: Partial<OcrPage> = {},
): OcrPage => ({
  number,
  text,
  markdown: text,
  blocks: [],
  tables: [],
  ...extra,
});
function checkOptions(c: ProviderContext, supportsPages = false) {
  if (c.options.rotate || c.options.grayscale || c.options.threshold)
    throw new ProviderError(
      "Image preprocessing is currently available through the built-in engine only.",
      true,
    );
  if (c.options.pages?.length && !supportsPages)
    throw new ProviderError(
      "This provider adapter requires the complete document; clear the page selection.",
      true,
    );
}
async function request(
  url: string,
  init: RequestInit,
  c: ProviderContext,
  accepted = false,
) {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([c.signal, AbortSignal.timeout(120000)]),
      dispatcher: dispatcher(c.store, c.secret.proxy),
    } as RequestInit);
  } catch {
    throw new ProviderError(
      "Provider connection interrupted or timed out. The submission status is uncertain.",
    );
  }
  if (!response.ok) {
    const retry = response.headers.get("retry-after");
    const seconds = retry
      ? Number.isFinite(Number(retry))
        ? Number(retry) * 1000
        : Math.max(0, Date.parse(retry) - Date.now())
      : 60000;
    throw new ProviderError(
      `Provider returned HTTP ${response.status}.`,
      !accepted &&
        [400, 401, 403, 404, 413, 415, 422, 429].includes(response.status),
      response.status === 429 ? seconds : 0,
      [401, 403].includes(response.status),
    );
  }
  return response;
}
async function json(
  url: string,
  init: RequestInit,
  c: ProviderContext,
  accepted = false,
): Promise<Wire> {
  const response = await request(url, init, c, accepted);
  let data: Buffer;
  try {
    data = await readLimitedBody(response, 30 * 1024 * 1024);
  } catch (error) {
    if (error instanceof ResponseLimitError)
      throw new ProviderError(
        "Provider result exceeds the response size limit.",
      );
    throw error;
  }
  const text = new TextDecoder().decode(data);
  try {
    return JSON.parse(text) as Wire;
  } catch {
    throw new ProviderError("Provider returned invalid JSON.");
  }
}
const jsonBody = (data: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(data),
});

export function normalizeMistral(data: Wire) {
  if (!Array.isArray(data.pages)) throw new ProviderError("Missing OCR pages.");
  return normalized(
    "mistral",
    "Mistral",
    data.pages.map((p: Wire, i: number) =>
      page(
        Number.isInteger(p.index) ? p.index + 1 : i + 1,
        String(p.markdown || ""),
        {
          width: p.dimensions?.width,
          height: p.dimensions?.height,
          confidence:
            p.confidence_scores?.average_page_confidence_score ?? null,
          fields: data.document_annotation
            ? { annotation: data.document_annotation }
            : undefined,
          blocks: (p.blocks || []).map((b: Wire) => ({
            text: String(b.content || b.text || ""),
            ...(Array.isArray(b.bbox) && b.bbox.length === 4
              ? { bbox: b.bbox }
              : {}),
          })),
          tables: (p.tables || []).map((t: Wire) => ({
            rows: markdownRows(String(t.content || "")),
          })),
        },
      ),
    ),
  );
}
export function markdownRows(markdown: string): string[][] {
  return markdown
    .split("\n")
    .filter(
      (line) =>
        line.trim().startsWith("|") && !/^\s*\|?[\s:|-]+\|?\s*$/.test(line),
    )
    .map((line) =>
      line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim()),
    );
}
providers.set("mistral", async (c) => {
  checkOptions(c, true);
  const document =
    c.file.format === "pdf"
      ? {
          type: "document_url",
          document_url: `data:${c.file.mime};base64,${bytes(c).toString("base64")}`,
        }
      : {
          type: "image_url",
          image_url: `data:${c.file.mime};base64,${bytes(c).toString("base64")}`,
        };
  const data = await json(
    "https://api.mistral.ai/v1/ocr",
    jsonBody(
      {
        model: c.secret.model || "mistral-ocr-latest",
        document,
        pages: c.options.pages?.map((n) => n - 1),
        include_image_base64: false,
        include_blocks: true,
        table_format: "markdown",
      },
      { Authorization: `Bearer ${c.secret.apiKey}` },
    ),
    c,
  );
  return normalizeMistral(data);
});

export function normalizeSpace(data: Wire) {
  if (data.IsErroredOnProcessing || !Array.isArray(data.ParsedResults))
    throw new ProviderError("OCR.space could not process this document.", true);
  return normalized(
    "ocrspace",
    "OCR.space",
    data.ParsedResults.map((p: Wire, i: number) =>
      page(i + 1, String(p.ParsedText || ""), {
        blocks: (p.TextOverlay?.Lines || []).map((line: Wire) => ({
          text: String(line.LineText || ""),
          bbox: [
            Math.min(...(line.Words || []).map((w: Wire) => Number(w.Left))),
            Number(line.MinTop),
            Math.max(
              ...(line.Words || []).map(
                (w: Wire) => Number(w.Left) + Number(w.Width),
              ),
            ),
            Number(line.MinTop) + Number(line.MaxHeight),
          ],
        })),
      }),
    ),
  );
}
providers.set("ocrspace", async (c) => {
  checkOptions(c);
  const maxBytes = Number(c.secret.maxFileMB || 1) * 1024 * 1024;
  const maxPages = Number(c.secret.maxPages || 3);
  if (c.file.size > maxBytes || c.file.pages > maxPages)
    throw new ProviderError(
      "Document exceeds this OCR.space plan. Configure plan limits or choose another engine.",
      true,
    );
  const form = new FormData();
  form.append("file", blob(c), c.file.name);
  form.append("language", c.options.language || "eng");
  form.append("isOverlayRequired", "true");
  return normalizeSpace(
    await json(
      c.secret.endpoint || "https://api.ocr.space/parse/image",
      { method: "POST", headers: { apikey: c.secret.apiKey }, body: form },
      c,
    ),
  );
});

providers.set("llamaparse", async (c) => {
  checkOptions(c, true);
  const client = new LlamaCloud({
    apiKey: c.secret.apiKey,
    maxRetries: 0,
    timeout: 120000,
  });
  let saved = c.operation ? JSON.parse(c.operation) : undefined;
  try {
    if (!saved) {
      const file = await client.files.create(
        {
          file: createReadStream(filePath(c.store, c.file.id)),
          purpose: "parse",
        },
        { signal: c.signal },
      );
      const job = await client.parsing.create(
        {
          file_id: file.id,
          tier: c.secret.tier || "fast",
          version: "latest",
          page_ranges: c.options.pages
            ? { target_pages: c.options.pages.join(",") }
            : undefined,
        },
        { signal: c.signal },
      );
      saved = { jobId: job.id, fileId: file.id };
      c.onOperation(JSON.stringify(saved));
    }
    const deadline = Date.now() + 30 * 60000;
    while (Date.now() < deadline) {
      const result = await client.parsing.get(
        saved.jobId,
        { expand: ["text", "markdown", "items", "usage"] },
        { signal: c.signal },
      );
      if (["FAILED", "CANCELLED"].includes(result.job.status))
        throw new ProviderError(
          "LlamaParse reported a terminal job failure.",
          true,
        );
      if (result.job.status === "COMPLETED") {
        const wire = result as unknown as Wire;
        const pages = wire.markdown?.pages || wire.text?.pages || [];
        if (pages.some((p: Wire) => p.success === false))
          throw new ProviderError("LlamaParse returned a failed page.", true);
        return normalized(
          "llamaparse",
          "LlamaIndex",
          pages.map((p: Wire, i: number) =>
            page(
              p.page_number || i + 1,
              String(
                wire.text?.pages?.find(
                  (t: Wire) => t.page_number === p.page_number,
                )?.text ||
                  p.text ||
                  p.markdown ||
                  "",
              ),
              {
                markdown: String(p.markdown || p.text || ""),
                tables: markdownRows(String(p.markdown || "")).length
                  ? [{ rows: markdownRows(p.markdown) }]
                  : [],
              },
            ),
          ),
          wire.job.usage?.credits ?? null,
        );
      }
      await delay(1500, undefined, { signal: c.signal });
    }
    throw new ProviderError(
      "LlamaParse is still processing. Its operation ID has been saved.",
    );
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    const status = (e as { status?: number }).status;
    throw new ProviderError(
      status
        ? `LlamaParse returned HTTP ${status}.`
        : "LlamaParse connection was interrupted.",
      !saved && Boolean(status && [400, 401, 403, 422, 429].includes(status)),
      status === 429 ? 60000 : 0,
      status === 401 || status === 403,
    );
  }
});

export function normalizeAzure(data: Wire) {
  const result = data.analyzeResult || data;
  if (!Array.isArray(result.pages))
    throw new ProviderError("Azure returned no pages.");
  const content = String(result.content || "");
  const pages: OcrPage[] = result.pages.map((p: Wire) =>
    page(
      p.pageNumber,
      (p.lines || []).map((line: Wire) => line.content).join("\n"),
      {
        width: p.width,
        height: p.height,
        blocks: (p.lines || []).map((line: Wire) => ({
          text: String(line.content || ""),
        })),
        tables: [],
      },
    ),
  );
  for (const table of result.tables || []) {
    const rows = Array.from({ length: table.rowCount }, () =>
      Array<string>(table.columnCount).fill(""),
    );
    for (const cell of table.cells || [])
      if (rows[cell.rowIndex])
        rows[cell.rowIndex][cell.columnIndex] = cell.content || "";
    pages
      .find((p) => p.number === table.boundingRegions?.[0]?.pageNumber)
      ?.tables.push({ rows });
  }
  for (const document of result.documents || []) {
    const number = document.boundingRegions?.[0]?.pageNumber || 1;
    const p = pages.find((p) => p.number === number);
    if (p) p.fields = document.fields;
  }
  return normalized(
    "azure",
    "Microsoft Azure",
    pages.length ? pages : [page(1, content)],
  );
}
providers.set("azure", async (c) => {
  checkOptions(c, true);
  const base = serviceUrl(c.secret.endpoint, "");
  const headers = { "Ocp-Apim-Subscription-Key": c.secret.apiKey };
  let operation = c.operation;
  if (!operation) {
    const model = c.options.capabilities?.includes("forms")
      ? "prebuilt-invoice"
      : "prebuilt-layout";
    const url = new URL(
      `${base}/documentintelligence/documentModels/${model}:analyze`,
    );
    url.searchParams.set("api-version", "2024-11-30");
    if (c.options.pages?.length)
      url.searchParams.set("pages", c.options.pages.join(","));
    const response = await request(
      url.toString(),
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/octet-stream" },
        body: new Uint8Array(bytes(c)),
      },
      c,
    );
    operation = response.headers.get("operation-location") || undefined;
    if (!operation)
      throw new ProviderError(
        "Azure accepted the document without returning an operation ID.",
      );
    if (new URL(operation).origin !== new URL(base).origin)
      throw new ProviderError("Azure returned an unexpected operation URL.");
    c.onOperation(operation);
  }
  if (new URL(operation).origin !== new URL(base).origin)
    throw new ProviderError(
      "Saved Azure operation does not match the configured endpoint.",
    );
  const deadline = Date.now() + 30 * 60000;
  while (Date.now() < deadline) {
    const data = await json(operation, { headers }, c, true);
    if (data.status === "succeeded") return normalizeAzure(data);
    if (["failed", "canceled"].includes(data.status))
      throw new ProviderError(
        "Azure reported a terminal document failure.",
        true,
      );
    await delay(1500, undefined, { signal: c.signal });
  }
  throw new ProviderError(
    "Azure is still processing; its operation ID is saved.",
  );
});

export function normalizeGoogle(data: Wire) {
  const document = data.document;
  if (!document || !Array.isArray(document.pages))
    throw new ProviderError("Google Document AI returned no document pages.");
  const text = String(document.text || "");
  const anchored = (anchor: Wire | undefined) =>
    (anchor?.textSegments || [])
      .map((s: Wire) =>
        text.slice(Number(s.startIndex || 0), Number(s.endIndex)),
      )
      .join("");
  return normalized(
    "google",
    "Google Cloud",
    document.pages.map((p: Wire, i: number) =>
      page(p.pageNumber || i + 1, anchored(p.layout?.textAnchor), {
        width: p.dimension?.width,
        height: p.dimension?.height,
        confidence: p.layout?.confidence ?? null,
        blocks: (p.blocks || []).map((b: Wire) => ({
          text: anchored(b.layout?.textAnchor),
          confidence: b.layout?.confidence ?? null,
        })),
        tables: (p.tables || []).map((table: Wire) => ({
          rows: [...(table.headerRows || []), ...(table.bodyRows || [])].map(
            (row: Wire) =>
              (row.cells || []).map((cell: Wire) =>
                anchored(cell.layout?.textAnchor),
              ),
          ),
        })),
        fields: Object.fromEntries(
          (p.formFields || []).map((field: Wire) => [
            anchored(field.fieldName?.textAnchor),
            anchored(field.fieldValue?.textAnchor),
          ]),
        ),
      }),
    ),
  );
}
providers.set("google", async (c) => {
  checkOptions(c);
  let account: Wire;
  try {
    account = JSON.parse(c.secret.serviceAccount);
  } catch {
    throw new ProviderError("Service account must be valid JSON.", true);
  }
  if (!account.client_email || !account.private_key)
    throw new ProviderError(
      "Service account requires client_email and private_key.",
      true,
    );
  for (const field of ["projectId", "location", "processorId"])
    if (!/^[a-zA-Z0-9_-]+$/.test(c.secret[field]))
      throw new ProviderError(`Invalid ${field}.`, true);
  const now = Math.floor(Date.now() / 1000);
  const head = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  ).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${payload}`);
  const signature = signer.sign(account.private_key, "base64url");
  const token = await json(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${head}.${payload}.${signature}`,
      }),
    },
    c,
  );
  if (!token.access_token)
    throw new ProviderError("Google did not return an access token.", true);
  const endpoint = `https://${c.secret.location}-documentai.googleapis.com/v1/projects/${c.secret.projectId}/locations/${c.secret.location}/processors/${c.secret.processorId}:process`;
  return normalizeGoogle(
    await json(
      endpoint,
      jsonBody(
        {
          rawDocument: {
            content: bytes(c).toString("base64"),
            mimeType: c.file.mime,
          },
        },
        { Authorization: `Bearer ${token.access_token}` },
      ),
      c,
    ),
  );
});

export function normalizeTextract(blocks: Block[]) {
  const pages = new Map<number, OcrPage>();
  const byId = new Map(blocks.map((b) => [b.Id, b]));
  const childText = (block: Block) =>
    (block.Relationships || [])
      .filter((r) => r.Type === "CHILD")
      .flatMap((r) => r.Ids || [])
      .map((id) => byId.get(id)?.Text || "")
      .join(" ");
  for (const block of blocks) {
    const n = block.Page || 1;
    if (!pages.has(n)) pages.set(n, page(n, ""));
    const p = pages.get(n)!;
    if (block.BlockType === "LINE") {
      p.text += (p.text ? "\n" : "") + (block.Text || "");
      p.markdown = p.text;
      p.blocks.push({
        text: block.Text || "",
        confidence:
          block.Confidence === undefined ? null : block.Confidence / 100,
      });
    }
    if (block.BlockType === "TABLE") {
      const cells = (block.Relationships || [])
        .filter((r) => r.Type === "CHILD")
        .flatMap((r) => r.Ids || [])
        .map((id) => byId.get(id))
        .filter((b): b is Block => Boolean(b?.BlockType === "CELL"));
      const rows = Array.from(
        { length: Math.max(0, ...cells.map((b) => b.RowIndex || 0)) },
        () =>
          Array<string>(
            Math.max(0, ...cells.map((b) => b.ColumnIndex || 0)),
          ).fill(""),
      );
      for (const cell of cells)
        rows[(cell.RowIndex || 1) - 1][(cell.ColumnIndex || 1) - 1] =
          childText(cell);
      p.tables.push({ rows });
    }
    if (
      block.BlockType === "KEY_VALUE_SET" &&
      block.EntityTypes?.includes("KEY")
    ) {
      const value = (block.Relationships || []).find((r) => r.Type === "VALUE")
        ?.Ids?.[0];
      const valueBlock = value ? byId.get(value) : undefined;
      p.fields = {
        ...p.fields,
        [childText(block)]: valueBlock ? childText(valueBlock) : "",
      };
    }
  }
  return normalized("textract", "AWS", [...pages.values()]);
}
providers.set("textract", async (c) => {
  checkOptions(c);
  const config = {
    region: c.secret.region,
    maxAttempts: 1,
    credentials: {
      accessKeyId: c.secret.accessKeyId,
      secretAccessKey: c.secret.secretAccessKey,
      ...(c.secret.sessionToken ? { sessionToken: c.secret.sessionToken } : {}),
    },
  };
  const s3 = new S3Client(config);
  const textract = new TextractClient(config);
  let operation = c.operation ? JSON.parse(c.operation) : undefined;
  let completed = false;
  try {
    if (!operation) {
      const objectKey = `freeocrapi/${randomUUID()}.${c.file.format}`;
      await s3.send(
        new PutObjectCommand({
          Bucket: c.secret.bucket,
          Key: objectKey,
          Body: bytes(c),
          ContentType: c.file.mime,
        }),
        { abortSignal: c.signal },
      );
      const analysis =
        c.options.capabilities?.some((cap) =>
          ["tables", "forms"].includes(cap),
        ) || false;
      const data = analysis
        ? await textract.send(
            new StartDocumentAnalysisCommand({
              DocumentLocation: {
                S3Object: { Bucket: c.secret.bucket, Name: objectKey },
              },
              FeatureTypes: ["TABLES", "FORMS"],
              ClientRequestToken: randomUUID(),
            }),
            { abortSignal: c.signal },
          )
        : await textract.send(
            new StartDocumentTextDetectionCommand({
              DocumentLocation: {
                S3Object: { Bucket: c.secret.bucket, Name: objectKey },
              },
              ClientRequestToken: randomUUID(),
            }),
            { abortSignal: c.signal },
          );
      if (!data.JobId)
        throw new ProviderError("Textract did not return a job ID.");
      operation = { jobId: data.JobId, objectKey, analysis };
      c.onOperation(JSON.stringify(operation));
    }
    const blocks: Block[] = [];
    const deadline = Date.now() + 30 * 60000;
    let nextToken: string | undefined;
    while (Date.now() < deadline) {
      const data = operation.analysis
        ? await textract.send(
            new GetDocumentAnalysisCommand({
              JobId: operation.jobId,
              NextToken: nextToken,
            }),
            { abortSignal: c.signal },
          )
        : await textract.send(
            new GetDocumentTextDetectionCommand({
              JobId: operation.jobId,
              NextToken: nextToken,
            }),
            { abortSignal: c.signal },
          );
      if (["FAILED", "PARTIAL_SUCCESS"].includes(data.JobStatus || "")) {
        completed = true;
        throw new ProviderError("Textract did not complete every page.", true);
      }
      if (data.JobStatus === "SUCCEEDED") {
        blocks.push(...(data.Blocks || []));
        nextToken = data.NextToken;
        if (!nextToken) {
          completed = true;
          return normalizeTextract(blocks);
        }
      } else await delay(1500, undefined, { signal: c.signal });
    }
    throw new ProviderError(
      "Textract is still processing; its operation ID is saved.",
    );
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata
      ?.httpStatusCode;
    throw new ProviderError(
      status
        ? `AWS returned HTTP ${status}.`
        : "AWS connection was interrupted.",
      !operation && Boolean(status && [400, 401, 403, 429].includes(status)),
      status === 429 ? 60000 : 0,
      status === 401 || status === 403,
    );
  } finally {
    if (completed && operation?.objectKey)
      await s3
        .send(
          new DeleteObjectCommand({
            Bucket: c.secret.bucket,
            Key: operation.objectKey,
          }),
        )
        .catch(() => {});
    s3.destroy();
    textract.destroy();
  }
});

export function normalizePaddle(data: Wire) {
  if (!Array.isArray(data.result?.ocrResults))
    throw new ProviderError("PaddleOCR returned an unexpected response.");
  return normalized(
    "paddleocr",
    "Local service",
    data.result.ocrResults.map((item: Wire, i: number) => {
      const p = item.prunedResult || {};
      return page((p.page_index ?? i) + 1, (p.rec_texts || []).join("\n"), {
        blocks: (p.rec_texts || []).map((text: string, n: number) => ({
          text,
          confidence: p.rec_scores?.[n] ?? null,
          ...(p.rec_polys?.[n]?.length
            ? {
                bbox: [
                  Math.min(...p.rec_polys[n].map((v: number[]) => v[0])),
                  Math.min(...p.rec_polys[n].map((v: number[]) => v[1])),
                  Math.max(...p.rec_polys[n].map((v: number[]) => v[0])),
                  Math.max(...p.rec_polys[n].map((v: number[]) => v[1])),
                ],
              }
            : {}),
        })),
      });
    }),
  );
}
providers.set("paddleocr", async (c) => {
  checkOptions(c);
  return normalizePaddle(
    await json(
      serviceUrl(c.secret.endpoint, "/ocr"),
      jsonBody({
        file: bytes(c).toString("base64"),
        fileType: c.file.format === "pdf" ? 0 : 1,
      }),
      c,
    ),
  );
});
providers.set("docling", async (c) => {
  checkOptions(c);
  const form = new FormData();
  form.append("files", blob(c), c.file.name);
  for (const format of ["md", "text", "json"])
    form.append("to_formats", format);
  form.append("do_ocr", "true");
  const data = await json(
    serviceUrl(c.secret.endpoint, "/v1/convert/file"),
    {
      method: "POST",
      body: form,
      headers: c.secret.apiKey ? { "X-Api-Key": c.secret.apiKey } : {},
    },
    c,
  );
  const doc = data.document || data.documents?.[0];
  if (!doc || data.status === "failure")
    throw new ProviderError("Docling could not convert the document.", true);
  const content = doc.json_content;
  const texts: Wire[] = content?.texts || [];
  const numbers = Object.keys(content?.pages || {})
    .map(Number)
    .sort((a, b) => a - b);
  if (!numbers.length && c.file.pages > 1)
    throw new ProviderError(
      "Docling did not return page provenance; the raw document requires review.",
    );
  return normalized(
    "docling",
    "Local service",
    (numbers.length ? numbers : [1]).map((n) => {
      const text =
        texts
          .filter((t) => t.prov?.some((p: Wire) => p.page_no === n))
          .map((t) => t.text || "")
          .join("\n") ||
        (numbers.length <= 1 ? String(doc.text_content || "") : "");
      const tables = (content?.tables || [])
        .filter((t: Wire) => t.prov?.some((p: Wire) => p.page_no === n))
        .map((t: Wire) => ({
          rows: (t.data?.grid || []).map((row: Wire[]) =>
            row.map((cell) => String(cell.text || "")),
          ),
        }));
      return page(n, text, {
        markdown: numbers.length ? text : String(doc.md_content || text),
        tables,
      });
    }),
  );
});
providers.set("custom", async (c) => {
  checkOptions(c);
  const form = new FormData();
  form.append("file", blob(c), c.file.name);
  form.append("options", JSON.stringify(c.options));
  const data = await json(
    serviceUrl(c.secret.endpoint, "/ocr"),
    {
      method: "POST",
      body: form,
      headers: c.secret.apiKey
        ? { Authorization: `Bearer ${c.secret.apiKey}` }
        : {},
    },
    c,
  );
  if (
    !Array.isArray(data.pages) ||
    data.pages.some(
      (p: Wire) => !Number.isInteger(p.number) || typeof p.text !== "string",
    )
  )
    throw new ProviderError(
      "Custom endpoint must return pages with number and text fields.",
    );
  return normalized(
    "custom",
    "Custom",
    data.pages.map((p: Wire) =>
      page(p.number, p.text, {
        markdown: typeof p.markdown === "string" ? p.markdown : p.text,
        blocks: Array.isArray(p.blocks) ? p.blocks : [],
        tables: Array.isArray(p.tables) ? p.tables : [],
        fields: p.fields,
        confidence: p.confidence ?? null,
      }),
    ),
    typeof data.usage?.credits === "number" ? data.usage.credits : null,
  );
});
