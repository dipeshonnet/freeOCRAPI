import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { Store, hash } from "./store.js";
import { catalog } from "./catalog.js";
import { getFile } from "./documents.js";
import { providers, ProviderError } from "./providers.js";
import { AppError } from "./errors.js";
import type { OcrOptions, OcrResult } from "../../shared/types.js";
import "./cloud-providers.js";
import { fetchDocument } from "./remote-documents.js";

function csvCell(value: unknown) {
  const text = String(value);
  // OCR is untrusted text. Quoting alone does not stop spreadsheet formulas.
  const protectedText = /^[\s\x00-\x1f]*[=+\-@＝＋－＠]|^[\t\r\n]/u.test(text)
    ? "'" + text
    : text;
  return `"${protectedText.replace(/"/g, '""')}"`;
}

export const optionsSchema = z.object({
  language: z
    .string()
    .regex(/^[a-z_+]+$/)
    .max(80)
    .optional(),
  pages: z.array(z.number().int().min(1)).max(10000).optional(),
  rotate: z
    .number()
    .refine((n) => [0, 90, 180, 270].includes(n))
    .optional(),
  grayscale: z.boolean().optional(),
  threshold: z.boolean().optional(),
  capabilities: z
    .array(z.enum(["text", "pdf", "tables", "forms", "handwriting", "layout"]))
    .optional(),
});
const inputSchema = z.object({
  fileId: z.string().uuid(),
  engine: z.string().max(80).default("auto"),
  profile: z.string().max(100).default("default"),
  options: optionsSchema.default({}),
});
interface JobRow {
  id: string;
  file_id: string;
  engine: string;
  requested_engine: string;
  profile: string;
  options: string;
  status: string;
  result: string | null;
  error: string | null;
  batch_id: string | null;
  created_at: string;
  updated_at: string;
  progress: number;
}
interface Attempt {
  id: string;
  engine: string;
  credential_id: string | null;
  status: string;
  operation: string | null;
  started_at: string;
}
interface Candidate {
  engine: string;
  credentialId: string | null;
  secret: Record<string, string>;
}
export function jobView(store: Store, row: JobRow, full = true) {
  return {
    id: row.id,
    fileId: row.file_id,
    filename: getFile(store, row.file_id).name,
    engine: row.engine,
    status: row.status,
    options: JSON.parse(row.options),
    error: row.error,
    batchId: row.batch_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    progress: row.progress,
    canResume:
      row.status === "needs_attention" &&
      Boolean(
        store.db
          .prepare(
            "SELECT id FROM attempts WHERE job_id=? AND operation IS NOT NULL ORDER BY started_at DESC LIMIT 1",
          )
          .get(row.id),
      ),
    ...(full
      ? {
          result: row.result ? JSON.parse(row.result) : null,
          attempts: store.db
            .prepare(
              "SELECT id,engine,status,error,pages,credits,started_at AS startedAt,ended_at AS endedAt,duration_ms AS durationMs FROM attempts WHERE job_id=? ORDER BY started_at",
            )
            .all(row.id),
        }
      : {}),
  };
}

export class JobQueue {
  private busy = false;
  private closed = false;
  private active?: { id: string; controller: AbortController };
  constructor(readonly store: Store) {
    this.recover();
    this.kick();
  }
  private recover() {
    const running = this.store.db
      .prepare("SELECT * FROM jobs WHERE status='running'")
      .all() as unknown as JobRow[];
    for (const job of running) {
      const attempt = this.store.db
        .prepare(
          "SELECT * FROM attempts WHERE job_id=? ORDER BY started_at DESC LIMIT 1",
        )
        .get(job.id) as unknown as Attempt | undefined;
      if (!attempt || attempt.engine === "tesseract") {
        if (attempt)
          this.store.db
            .prepare(
              "UPDATE attempts SET status='failed',error='Interrupted local processing',ended_at=? WHERE id=?",
            )
            .run(new Date().toISOString(), attempt.id);
        this.store.db
          .prepare("UPDATE jobs SET status='queued' WHERE id=?")
          .run(job.id);
      } else if (attempt.operation) {
        this.store.db
          .prepare("UPDATE attempts SET status='running' WHERE id=?")
          .run(attempt.id);
        this.store.db
          .prepare("UPDATE jobs SET status='queued' WHERE id=?")
          .run(job.id);
      } else {
        this.store.db
          .prepare("UPDATE attempts SET status='unknown' WHERE id=?")
          .run(attempt.id);
        this.finish(
          job.id,
          "needs_attention",
          "An upstream submission may still be running. Review this attempt before retrying.",
        );
      }
    }
  }
  submit(raw: unknown, batchId: string | null = null) {
    const input = inputSchema.parse(raw);
    const file = getFile(this.store, input.fileId);
    if (input.engine === "auto" && input.profile === "default") {
      const rules =
        this.store.setting<
          { format: string; minPages: number; profile: string }[]
        >("rules") || [];
      const match = rules.find(
        (rule) =>
          (rule.format === "any" || rule.format === file.format) &&
          file.pages >= rule.minPages,
      );
      if (match) input.profile = match.profile;
    }
    if (input.options.pages?.some((n) => n > file.pages))
      throw new AppError(400, "Page selection is outside the document.");
    if (input.engine !== "auto" && !catalog.some((e) => e.id === input.engine))
      throw new AppError(400, "Unknown OCR engine.");
    if (
      !this.store.db
        .prepare("SELECT id FROM profiles WHERE id=?")
        .get(input.profile)
    )
      throw new AppError(400, "Unknown routing profile.");
    const id = randomUUID();
    const now = new Date().toISOString();
    this.store.db
      .prepare(
        "INSERT INTO jobs(id,file_id,engine,requested_engine,profile,options,status,batch_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        file.id,
        input.engine,
        input.engine,
        input.profile,
        JSON.stringify(input.options),
        "queued",
        batchId,
        now,
        now,
      );
    this.kick();
    return this.get(id);
  }
  get(id: string) {
    const row = this.store.db
      .prepare("SELECT * FROM jobs WHERE id=?")
      .get(id) as unknown as JobRow | undefined;
    if (!row) throw new AppError(404, "Job not found.");
    return jobView(this.store, row);
  }
  list(query = "") {
    const rows = this.store.db
      .prepare(
        "SELECT j.* FROM jobs j JOIN files f ON f.id=j.file_id WHERE f.name LIKE ? OR j.id LIKE ? ORDER BY j.created_at DESC LIMIT 200",
      )
      .all(`%${query}%`, `%${query}%`) as unknown as JobRow[];
    return rows.map((row) => jobView(this.store, row, false));
  }
  cancel(id: string) {
    const job = this.get(id);
    if (
      ["succeeded", "failed", "cancelled", "needs_attention"].includes(
        job.status,
      )
    )
      throw new AppError(409, "Job is already finished.");
    this.finish(
      id,
      "cancelled",
      "Cancelled by user. Upstream work may continue if the provider cannot cancel it.",
    );
    if (this.active?.id === id) this.active.controller.abort();
    return this.get(id);
  }
  private finish(
    id: string,
    status: string,
    error: string | null,
    result?: OcrResult,
  ) {
    this.store.db
      .prepare(
        "UPDATE jobs SET status=?,error=?,result=?,updated_at=? WHERE id=?",
      )
      .run(
        status,
        error,
        result ? JSON.stringify(result) : null,
        new Date().toISOString(),
        id,
      );
  }
  resume(id: string) {
    const job = this.get(id);
    if (!job.canResume)
      throw new AppError(
        409,
        "This job has no saved upstream operation that can be resumed safely.",
      );
    const attempt = this.store.db
      .prepare(
        "SELECT id FROM attempts WHERE job_id=? AND operation IS NOT NULL ORDER BY started_at DESC LIMIT 1",
      )
      .get(id)!;
    this.store.db
      .prepare("UPDATE attempts SET status='running' WHERE id=?")
      .run(String(attempt.id));
    this.store.db
      .prepare("UPDATE jobs SET status='queued',error=NULL WHERE id=?")
      .run(id);
    this.kick();
    return this.get(id);
  }
  kick() {
    if (!this.closed)
      setImmediate(() => {
        void this.pump();
      });
  }
  private candidates(job: JobRow, options: OcrOptions): Candidate[] {
    const profile = this.store.db
      .prepare("SELECT engines,strategy FROM profiles WHERE id=?")
      .get(job.profile) as { engines: string; strategy: string };
    const order: string[] =
      job.requested_engine === "auto"
        ? JSON.parse(profile.engines)
        : [job.requested_engine];
    const file = getFile(this.store, job.file_id);
    const candidates: Candidate[] = [];
    for (const id of order) {
      const def = catalog.find((e) => e.id === id);
      if (
        !def ||
        !providers.has(id) ||
        !def.formats.includes(file.format) ||
        options.capabilities?.some((c) => !def.capabilities.includes(c))
      )
        continue;
      if (
        !this.store.db.prepare("SELECT enabled FROM engines WHERE id=?").get(id)
          ?.enabled
      )
        continue;
      if (id === "tesseract") {
        candidates.push({ engine: id, credentialId: null, secret: {} });
        continue;
      }
      const keys = this.store.db
        .prepare(
          "SELECT * FROM credentials WHERE engine=? AND enabled=1 AND status!='invalid' ORDER BY checked_at,id",
        )
        .all(id);
      for (const key of keys) {
        const cooldown = this.store.db
          .prepare("SELECT until_at FROM cooldowns WHERE scope=?")
          .get(String(key.id));
        if (cooldown && Number(cooldown.until_at) > Date.now()) continue;
        const usage = this.store.db
          .prepare(
            "SELECT COUNT(*) AS requests,COALESCE(SUM(reserved_pages),0) AS pages FROM attempts WHERE credential_id=? AND started_at>=? AND status IN ('running','unknown')",
          )
          .get(
            String(key.id),
            new Date().toISOString().slice(0, 7) + "-01T00:00:00.000Z",
          )!;
        const pages = options.pages?.length || file.pages;
        const settled = this.store.db
          .prepare(
            "SELECT requests,pages FROM monthly_usage WHERE credential_id=? AND month=?",
          )
          .get(String(key.id), new Date().toISOString().slice(0, 7));
        if (
          (Number(key.request_cap) > 0 &&
            Number(usage.requests) + Number(settled?.requests || 0) >=
              Number(key.request_cap)) ||
          (Number(key.page_cap) > 0 &&
            Number(usage.pages) + Number(settled?.pages || 0) + pages >
              Number(key.page_cap))
        )
          continue;
        candidates.push({
          engine: id,
          credentialId: String(key.id),
          secret: this.store.decrypt(String(key.secret)),
        });
      }
    }
    const strategy =
      job.profile === "default"
        ? this.store.setting<{ strategy: string }>("routing")!.strategy
        : profile.strategy;
    if (strategy !== "manual") {
      const scores = new Map<string, number>();
      for (const candidate of candidates) {
        const stats = this.store.db
          .prepare(
            "SELECT COUNT(*) AS total,SUM(status='succeeded') AS successes,AVG(CASE WHEN status='succeeded' THEN duration_ms END) AS latency FROM attempts WHERE engine=? AND status IN ('succeeded','failed')",
          )
          .get(candidate.engine)!;
        const reliability =
          (Number(stats.successes) + 1) / (Number(stats.total) + 2);
        const speed = stats.latency
          ? 1 / (1 + Number(stats.latency) / 10000)
          : 0.5;
        const weights = this.store.setting<{
          weights: { reliability: number; speed: number; quality: number };
        }>("routing")!.weights;
        const denominator =
          weights.reliability + weights.speed + weights.quality || 1;
        scores.set(
          candidate.engine,
          strategy === "fastest"
            ? speed
            : strategy === "reliable"
              ? reliability
              : strategy === "custom"
                ? (weights.reliability * reliability +
                    weights.speed * speed +
                    weights.quality * 0.5) /
                  denominator
                : strategy === "quality"
                  ? 0.5
                  : 0.7 * reliability + 0.3 * speed,
        );
      }
      candidates.sort((a, b) => scores.get(b.engine)! - scores.get(a.engine)!);
    }
    return candidates;
  }
  private async pump() {
    if (this.busy || this.closed) return;
    const job = this.store.db
      .prepare(
        "SELECT * FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1",
      )
      .get() as unknown as JobRow | undefined;
    if (!job) return;
    this.busy = true;
    const controller = new AbortController();
    this.active = { id: job.id, controller };
    try {
      this.store.db
        .prepare("UPDATE jobs SET status='running',updated_at=? WHERE id=?")
        .run(new Date().toISOString(), job.id);
      const options = JSON.parse(job.options) as OcrOptions;
      const file = getFile(this.store, job.file_id);
      const resumed = this.store.db
        .prepare(
          "SELECT * FROM attempts WHERE job_id=? AND status='running' AND operation IS NOT NULL ORDER BY started_at DESC LIMIT 1",
        )
        .get(job.id) as unknown as Attempt | undefined;
      let candidates: Candidate[];
      if (resumed) {
        const key = resumed.credential_id
          ? this.store.db
              .prepare("SELECT secret FROM credentials WHERE id=?")
              .get(resumed.credential_id)
          : undefined;
        if (resumed.credential_id && !key)
          throw new AppError(
            409,
            "The credential for the running provider operation is unavailable.",
          );
        candidates = [
          {
            engine: resumed.engine,
            credentialId: resumed.credential_id,
            secret: key ? this.store.decrypt(String(key.secret)) : {},
          },
        ];
      } else candidates = this.candidates(job, options);
      if (!candidates.length)
        throw new AppError(
          429,
          "No enabled engine can serve this document with the required capabilities and available quota.",
        );
      let lastError = "All eligible engines failed.";
      for (const candidate of candidates) {
        if (controller.signal.aborted) break;
        const cacheKey = hash(
          JSON.stringify({
            file: file.sha256,
            engine: candidate.engine,
            options,
            schema: 1,
          }),
        );
        if (
          !resumed &&
          this.store.setting<{ cacheEnabled: boolean }>("preferences")
            ?.cacheEnabled
        ) {
          const cached = this.store.db
            .prepare("SELECT result FROM cache WHERE key=?")
            .get(cacheKey);
          if (cached) {
            this.store.db
              .prepare("UPDATE jobs SET engine=? WHERE id=?")
              .run(candidate.engine, job.id);
            this.finish(job.id, "succeeded", null, {
              ...JSON.parse(String(cached.result)),
              cached: true,
            });
            break;
          }
        }
        const attemptId = resumed?.id || randomUUID();
        const started = Date.now();
        if (!resumed)
          this.store.db
            .prepare(
              "INSERT INTO attempts(id,job_id,engine,credential_id,status,reserved_pages,started_at) VALUES(?,?,?,?,?,?,?)",
            )
            .run(
              attemptId,
              job.id,
              candidate.engine,
              candidate.credentialId,
              "running",
              options.pages?.length || file.pages,
              new Date().toISOString(),
            );
        this.store.db
          .prepare("UPDATE jobs SET engine=? WHERE id=?")
          .run(candidate.engine, job.id);
        try {
          const provider = providers.get(candidate.engine);
          if (!provider)
            throw new ProviderError(
              "Provider is unavailable; its saved operation was not resubmitted.",
            );
          const result = await provider({
            store: this.store,
            file,
            options,
            secret: candidate.secret,
            signal: controller.signal,
            operation: resumed?.operation || undefined,
            onOperation: (operation) => {
              this.store.db
                .prepare("UPDATE attempts SET operation=? WHERE id=?")
                .run(operation, attemptId);
            },
            progress: (page) => {
              this.store.db
                .prepare("UPDATE jobs SET progress=? WHERE id=?")
                .run(page, job.id);
            },
          });
          this.store.db.exec("BEGIN IMMEDIATE");
          try {
            this.store.db
              .prepare(
                "UPDATE attempts SET status='succeeded',pages=?,credits=?,duration_ms=?,ended_at=? WHERE id=?",
              )
              .run(
                result.usage.pages,
                result.usage.credits,
                Date.now() - started,
                new Date().toISOString(),
                attemptId,
              );
            this.store.db
              .prepare(
                "INSERT INTO monthly_usage VALUES(?,?,?,?,?,?) ON CONFLICT(credential_id,month) DO UPDATE SET requests=requests+1,pages=pages+excluded.pages,credits=credits+excluded.credits",
              )
              .run(
                candidate.credentialId || `local:${candidate.engine}`,
                candidate.engine,
                (resumed?.started_at || new Date().toISOString()).slice(0, 7),
                1,
                result.usage.pages,
                result.usage.credits || 0,
              );
            if (candidate.credentialId)
              this.store.db
                .prepare(
                  "UPDATE credentials SET status='healthy',checked_at=? WHERE id=?",
                )
                .run(new Date().toISOString(), candidate.credentialId);
            this.store.db.exec("COMMIT");
          } catch (error) {
            this.store.db.exec("ROLLBACK");
            throw error;
          }
          if (!controller.signal.aborted) {
            this.finish(job.id, "succeeded", null, result);
            if (
              this.store.setting<{ cacheEnabled: boolean }>("preferences")
                ?.cacheEnabled
            )
              this.store.db
                .prepare("INSERT OR REPLACE INTO cache VALUES(?,?,?)")
                .run(
                  cacheKey,
                  JSON.stringify(result),
                  new Date().toISOString(),
                );
          }
          break;
        } catch (error) {
          const safe =
            candidate.engine === "tesseract" ||
            (error instanceof ProviderError && error.safeToFallback);
          lastError =
            error instanceof AppError || error instanceof ProviderError
              ? error.message
              : "The engine could not complete processing.";
          this.store.db
            .prepare(
              "UPDATE attempts SET status=?,error=?,ended_at=?,duration_ms=? WHERE id=?",
            )
            .run(
              safe ? "failed" : "unknown",
              lastError,
              new Date().toISOString(),
              Date.now() - started,
              attemptId,
            );
          if (error instanceof ProviderError && candidate.credentialId) {
            if (error.invalidCredential)
              this.store.db
                .prepare(
                  "UPDATE credentials SET status='invalid',checked_at=? WHERE id=?",
                )
                .run(new Date().toISOString(), candidate.credentialId);
            if (error.retryAfter)
              this.store.db
                .prepare("INSERT OR REPLACE INTO cooldowns VALUES(?,?)")
                .run(candidate.credentialId, Date.now() + error.retryAfter);
          }
          if (controller.signal.aborted) break;
          if (!safe) {
            this.finish(
              job.id,
              "needs_attention",
              lastError +
                " The upstream submission may still exist; automatic fallback was stopped.",
            );
            break;
          }
        }
      }
      if (!controller.signal.aborted && this.get(job.id).status === "running")
        this.finish(job.id, "failed", lastError);
    } catch (e) {
      if (!controller.signal.aborted)
        this.finish(
          job.id,
          "failed",
          e instanceof AppError
            ? e.message
            : "Processing could not be completed.",
        );
    } finally {
      this.active = undefined;
      this.busy = false;
      this.kick();
    }
  }
  async close() {
    this.closed = true;
    this.active?.controller.abort();
    while (this.busy) await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export function jobRoutes(queue: JobQueue) {
  const router = Router();
  router.post("/ocr", async (req, res) => {
    if (req.body.url && req.body.fileId)
      throw new AppError(400, "Supply fileId or url, not both.");
    if (req.body.url) {
      const url = z.string().url().max(4000).parse(req.body.url);
      const file = await fetchDocument(queue.store, url);
      req.body = { ...req.body, fileId: file.id };
      delete req.body.url;
    }
    const job = queue.submit(req.body);
    res.status(202).location(`/v1/jobs/${job.id}`).json(job);
  });
  router.get("/jobs", (req, res) =>
    res.json(queue.list(String(req.query.q || "").slice(0, 200))),
  );
  router.get("/jobs/:id", (req, res) =>
    res.json(queue.get(String(req.params.id))),
  );
  router.post("/jobs/:id/cancel", (req, res) =>
    res.json(queue.cancel(String(req.params.id))),
  );
  router.post("/jobs/:id/resume", (req, res) =>
    res.json(queue.resume(String(req.params.id))),
  );
  router.post("/batches", (req, res) => {
    const input = z
      .object({ files: z.array(inputSchema).min(1).max(100) })
      .parse(req.body);
    const id = randomUUID();
    queue.store.db.exec("BEGIN IMMEDIATE");
    try {
      const jobs = input.files.map((item) => queue.submit(item, id));
      queue.store.db.exec("COMMIT");
      res.status(202).json({ id, jobs });
    } catch (e) {
      queue.store.db.exec("ROLLBACK");
      throw e;
    }
  });
  router.get("/jobs/:id/download", (req, res) => {
    const job = queue.get(String(req.params.id));
    if (job.status !== "succeeded" || !job.result)
      throw new AppError(409, "The document has no completed result.");
    const format = z
      .enum(["txt", "md", "json", "csv"])
      .parse(req.query.format || "txt");
    const result = job.result as OcrResult;
    const text =
      format === "json"
        ? JSON.stringify(result, null, 2)
        : format === "md"
          ? result.markdown
          : format === "csv"
            ? result.pages
                .flatMap((p) => p.tables)
                .flatMap((t) => t.rows)
                .map((row) => row.map(csvCell).join(","))
                .join("\r\n")
            : result.text;
    res.type(
      format === "json"
        ? "application/json"
        : format === "csv"
          ? "text/csv"
          : "text/plain",
    );
    res.attachment(`ocr-result.${format}`).send(text);
  });
  return router;
}
