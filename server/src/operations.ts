import { Router } from "express";
import multer from "multer";
import { backup, DatabaseSync } from "node:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  scryptSync,
} from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
  unlinkSync,
  renameSync,
  copyFileSync,
} from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { z } from "zod";
import { Store, hash } from "./store.js";
import { catalog } from "./catalog.js";
import { AppError } from "./errors.js";
import { serviceUrl } from "./cloud-providers.js";
import type { JobQueue } from "./jobs.js";
import { filePath } from "./documents.js";
import { readLimitedBody, ResponseLimitError } from "./network.js";

const passwordSchema = z.string().min(12).max(256);
export function seal(value: unknown, password: string) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(password, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  key.fill(0);
  return {
    version: 1,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}
export function unseal(envelope: unknown, password: string): unknown {
  try {
    const e = z
      .object({
        version: z.literal(1),
        salt: z.string(),
        iv: z.string(),
        tag: z.string(),
        data: z.string(),
      })
      .parse(envelope);
    const key = scryptSync(password, Buffer.from(e.salt, "base64"), 32);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(e.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(e.tag, "base64"));
    const text = Buffer.concat([
      decipher.update(Buffer.from(e.data, "base64")),
      decipher.final(),
    ]);
    key.fill(0);
    return JSON.parse(text.toString());
  } catch {
    throw new AppError(
      400,
      "Incorrect backup password or invalid encrypted backup.",
    );
  }
}
function decodeWithKey(secret: string, key: Buffer) {
  const value = Buffer.from(secret, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
  decipher.setAuthTag(value.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([
      decipher.update(value.subarray(28)),
      decipher.final(),
    ]).toString(),
  );
}
const safeBackup = (name: string) =>
  /^backup-[\dT-]+-[a-f\d-]+\.ocrbackup$/.test(name);
export async function createBackup(store: Store, password: string) {
  passwordSchema.parse(password);
  const directory = path.join(store.dataDir, "backups");
  mkdirSync(directory, { recursive: true });
  const id = randomUUID();
  const snapshot = path.join(directory, `.snapshot-${id}.db`);
  try {
    await backup(store.db, snapshot);
    const snapshotDb = new DatabaseSync(snapshot);
    let ids: string[];
    try {
      ids = snapshotDb
        .prepare("SELECT id FROM files")
        .all()
        .map((row) => String(row.id));
    } finally {
      snapshotDb.close();
    }
    let total = statSync(snapshot).size;
    for (const id of ids) {
      total += statSync(filePath(store, id)).size;
      if (total > 128 * 1024 * 1024)
        throw new AppError(
          413,
          "This backup exceeds the 128 MB archive limit. Use an offline data-directory backup.",
        );
    }
    const key =
      process.env.ENCRYPTION_KEY ||
      readFileSync(path.join(store.dataDir, ".encryption-key")).toString("hex");
    const payload = {
      version: 1,
      db: readFileSync(snapshot).toString("base64"),
      key,
      files: ids.map((id) => ({
        id,
        data: readFileSync(filePath(store, id)).toString("base64"),
      })),
    };
    const envelope = seal(payload, password);
    const name = `backup-${new Date().toISOString().replace(/[:.Z]/g, "-")}-${id}.ocrbackup`;
    writeFileSync(path.join(directory, name), JSON.stringify(envelope), {
      mode: 0o600,
      flag: "wx",
    });
    return {
      name,
      createdAt: new Date().toISOString(),
      size: statSync(path.join(directory, name)).size,
    };
  } finally {
    if (existsSync(snapshot)) unlinkSync(snapshot);
  }
}

export function applyPendingRestore(dataDir: string) {
  const root = path.resolve(dataDir);
  const marker = path.join(root, "restore.pending");
  if (!existsSync(marker)) return;
  const value = JSON.parse(readFileSync(marker, "utf8")) as {
    directory: string;
  };
  if (!/^restore-[a-f\d-]+$/.test(value.directory))
    throw new Error("Invalid restore staging directory");
  const stage = path.resolve(root, value.directory);
  if (path.dirname(stage) !== root)
    throw new Error("Restore path is outside the data directory");
  const database = path.join(root, "freeocrapi.db");
  if (existsSync(database))
    renameSync(
      database,
      path.join(root, `freeocrapi.before-restore-${Date.now()}.db`),
    );
  for (const suffix of ["-wal", "-shm"])
    if (existsSync(database + suffix)) unlinkSync(database + suffix);
  renameSync(path.join(stage, "restore.db"), database);
  mkdirSync(path.join(root, "files"), { recursive: true });
  for (const id of readdirSync(path.join(stage, "files"))) {
    z.string().uuid().parse(id);
    copyFileSync(path.join(stage, "files", id), path.join(root, "files", id));
  }
  unlinkSync(marker);
}

export async function prepareRestore(
  store: Store,
  queue: JobQueue,
  envelope: unknown,
  password: string,
) {
  passwordSchema.parse(password);
  const payload = z
    .object({
      version: z.literal(1),
      db: z.string(),
      key: z.string().regex(/^[a-f\d]{64}$/i),
      files: z.array(z.object({ id: z.string().uuid(), data: z.string() })),
    })
    .parse(unseal(envelope, password));
  const data = Buffer.from(payload.db, "base64");
  if (data.subarray(0, 15).toString() !== "SQLite format 3")
    throw new AppError(400, "Backup database is invalid.");
  const stageName = `restore-${randomUUID()}`;
  const stage = path.join(store.dataDir, stageName);
  mkdirSync(path.join(stage, "files"), { recursive: true });
  writeFileSync(path.join(stage, "restore.db"), data, { mode: 0o600 });
  const db = new DatabaseSync(path.join(stage, "restore.db"));
  try {
    if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
      throw new AppError(400, "Backup integrity check failed.");
    const oldKey = Buffer.from(payload.key, "hex");
    for (const row of db.prepare("SELECT id,secret FROM credentials").all())
      db.prepare("UPDATE credentials SET secret=? WHERE id=?").run(
        store.encrypt(decodeWithKey(String(row.secret), oldKey)),
        String(row.id),
      );
    const unified = db
      .prepare("SELECT value FROM settings WHERE key='unifiedKey'")
      .get();
    if (unified)
      db.prepare("UPDATE settings SET value=? WHERE key='unifiedKey'").run(
        JSON.stringify(
          store.encrypt(
            decodeWithKey(JSON.parse(String(unified.value)), oldKey),
          ),
        ),
      );
    oldKey.fill(0);
    db.exec(
      "DELETE FROM sessions; DELETE FROM resets; DELETE FROM settings WHERE key='restorePending'; PRAGMA wal_checkpoint(TRUNCATE);",
    );
    const required = new Set(
      db
        .prepare("SELECT id FROM files")
        .all()
        .map((row) => String(row.id)),
    );
    for (const file of payload.files) {
      if (!required.has(file.id))
        throw new AppError(400, "Backup contains an unreferenced file.");
      writeFileSync(
        path.join(stage, "files", file.id),
        Buffer.from(file.data, "base64"),
        { mode: 0o600 },
      );
      required.delete(file.id);
    }
    if (required.size)
      throw new AppError(400, "Backup is missing document files.");
  } finally {
    db.close();
  }
  await createBackup(store, password);
  await queue.close();
  store.setSetting("restorePending", true);
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  writeFileSync(
    path.join(store.dataDir, "restore.pending"),
    JSON.stringify({ directory: stageName }),
    { mode: 0o600 },
  );
  return {
    restartRequired: true,
    message:
      "Restore prepared. Restart FreeOCRapi to use the restored account and documents. A pre-restore backup was saved.",
  };
}

export function runRetention(store: Store) {
  const days = store.setting<{ retentionDays: number }>(
    "preferences",
  )!.retentionDays;
  const before = new Date(Date.now() - days * 86400000).toISOString();
  store.db
    .prepare(
      "DELETE FROM jobs WHERE updated_at<? AND status IN ('succeeded','failed','cancelled') AND NOT EXISTS(SELECT 1 FROM attempts WHERE attempts.job_id=jobs.id AND attempts.status IN ('unknown','running'))",
    )
    .run(before);
  store.db.prepare("DELETE FROM cache WHERE created_at<?").run(before);
  for (const row of store.db
    .prepare(
      "SELECT id FROM files WHERE created_at<? AND NOT EXISTS(SELECT 1 FROM jobs WHERE jobs.file_id=files.id)",
    )
    .all(before)) {
    const id = String(row.id);
    if (!z.string().uuid().safeParse(id).success) continue;
    const target = filePath(store, id);
    if (existsSync(target)) unlinkSync(target);
    store.db.prepare("DELETE FROM files WHERE id=?").run(id);
  }
  store.db.prepare("DELETE FROM sessions WHERE expires_at<?").run(Date.now());
  store.db.prepare("DELETE FROM resets WHERE expires_at<?").run(Date.now());
}

export async function checkCredential(store: Store, id: string) {
  const row = store.db
    .prepare("SELECT engine,secret FROM credentials WHERE id=?")
    .get(id);
  if (!row) throw new AppError(404, "Credential not found.");
  const secret = store.decrypt(String(row.secret));
  let endpoint: string | undefined;
  let headers: Record<string, string> = {};
  if (row.engine === "llamaparse") {
    endpoint = "https://api.cloud.llamaindex.ai/api/v2/parse/versions";
    headers.Authorization = `Bearer ${secret.apiKey}`;
  }
  if (row.engine === "mistral") {
    endpoint = "https://api.mistral.ai/v1/models";
    headers.Authorization = `Bearer ${secret.apiKey}`;
  }
  if (row.engine === "docling") {
    endpoint = serviceUrl(secret.endpoint, "/health");
    if (secret.apiKey) headers["X-Api-Key"] = secret.apiKey;
  }
  if (!endpoint) {
    store.db
      .prepare(
        "UPDATE credentials SET status='unknown',checked_at=? WHERE id=?",
      )
      .run(new Date().toISOString(), id);
    return {
      status: "unknown",
      message:
        "This provider has no configured non-billable credential check. Run an OCR document to verify it.",
    };
  }
  let status = "unknown";
  try {
    const response = await fetch(endpoint, {
      headers,
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    status = response.ok
      ? "healthy"
      : [401, 403].includes(response.status)
        ? "invalid"
        : response.status === 429
          ? "rate_limited"
          : "error";
    await response.body?.cancel();
  } catch {
    status = "error";
  }
  store.db
    .prepare("UPDATE credentials SET status=?,checked_at=? WHERE id=?")
    .run(status, new Date().toISOString(), id);
  return { status };
}

export function operationRoutes(store: Store, queue: JobQueue) {
  const router = Router();
  router.post("/keys/check", async (_req, res) => {
    const result = [];
    for (const row of store.db
      .prepare("SELECT id FROM credentials WHERE enabled=1")
      .all())
      result.push({
        id: row.id,
        ...(await checkCredential(store, String(row.id))),
      });
    res.json(result);
  });
  router.post("/keys/:id/check", async (req, res) =>
    res.json(await checkCredential(store, String(req.params.id))),
  );
  router.get("/keys/export", (_req, res) => {
    const credentials = store.db.prepare("SELECT * FROM credentials").all();
    res.attachment("freeocrapi-credentials.encrypted.json").json({
      version: 1,
      type: "freeocrapi-credentials",
      fingerprint: hash(store.unifiedKey()).slice(0, 16),
      payload: store.encrypt(credentials),
    });
  });
  router.post("/keys/import", (req, res) => {
    const value = z
      .object({
        version: z.literal(1),
        type: z.literal("freeocrapi-credentials"),
        payload: z.string(),
      })
      .parse(req.body);
    let rows: Record<string, unknown>[];
    try {
      rows = store.decrypt(value.payload);
    } catch {
      throw new AppError(
        400,
        "This credential export requires the original installation encryption key. Use an encrypted full backup to migrate.",
      );
    }
    let imported = 0;
    store.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        if (!catalog.some((e) => e.id === row.engine))
          throw new AppError(400, "Unknown provider in credential export.");
        store.db
          .prepare(
            "INSERT OR IGNORE INTO credentials(id,engine,label,secret,enabled,status,request_cap,page_cap) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(
            z.string().uuid().parse(row.id),
            String(row.engine),
            String(row.label),
            String(row.secret),
            Number(row.enabled),
            "unknown",
            Number(row.request_cap),
            Number(row.page_cap),
          );
        imported++;
      }
      store.db.exec("COMMIT");
    } catch (e) {
      store.db.exec("ROLLBACK");
      throw e;
    }
    res.json({ imported });
  });
  router.get("/catalog/export", (_req, res) =>
    res.attachment("freeocrapi-catalog.json").json({
      version: 1,
      engines: store.db
        .prepare("SELECT * FROM engines")
        .all()
        .map((row) => ({ ...row, enabled: Boolean(row.enabled) })),
      profiles: store.db
        .prepare("SELECT * FROM profiles")
        .all()
        .map((row) => ({ ...row, engines: JSON.parse(String(row.engines)) })),
      routing: store.setting("routing"),
    }),
  );
  router.post("/catalog/import", (req, res) => {
    const value = z
      .object({
        version: z.literal(1),
        engines: z
          .array(
            z.object({
              id: z.string(),
              enabled: z.boolean(),
              priority: z.number().int().min(0),
            }),
          )
          .max(100),
        profiles: z
          .array(
            z.object({
              id: z.string().min(1).max(100),
              name: z.string().min(1).max(100),
              engines: z
                .array(
                  z.enum(catalog.map((e) => e.id) as [string, ...string[]]),
                )
                .max(100),
              strategy: z.enum([
                "manual",
                "balanced",
                "quality",
                "fastest",
                "reliable",
                "custom",
              ]),
            }),
          )
          .max(100)
          .optional(),
        routing: z
          .object({
            strategy: z.enum([
              "manual",
              "balanced",
              "quality",
              "fastest",
              "reliable",
              "custom",
            ]),
            weights: z.object({
              reliability: z.number().min(0).max(1),
              speed: z.number().min(0).max(1),
              quality: z.number().min(0).max(1),
            }),
          })
          .optional(),
      })
      .parse(req.body);
    for (const engine of value.engines)
      if (!catalog.some((e) => e.id === engine.id))
        throw new AppError(400, `Unknown engine: ${engine.id}`);
    store.db.exec("BEGIN IMMEDIATE");
    try {
      for (const engine of value.engines)
        store.db
          .prepare("UPDATE engines SET enabled=?,priority=? WHERE id=?")
          .run(Number(engine.enabled), engine.priority, engine.id);
      for (const profile of value.profiles || [])
        store.db
          .prepare(
            "INSERT INTO profiles VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,engines=excluded.engines,strategy=excluded.strategy",
          )
          .run(
            profile.id,
            profile.name,
            JSON.stringify(profile.engines),
            profile.strategy,
          );
      if (value.routing) store.setSetting("routing", value.routing);
      store.db.exec("COMMIT");
    } catch (e) {
      store.db.exec("ROLLBACK");
      throw e;
    }
    res.json({ ok: true });
  });
  router.post("/cache/clear", (_req, res) => {
    store.db.exec("DELETE FROM cache");
    res.json({ ok: true });
  });
  router.get("/backups", (_req, res) => {
    const directory = path.join(store.dataDir, "backups");
    res.json(
      existsSync(directory)
        ? readdirSync(directory)
            .filter(safeBackup)
            .map((name) => {
              const stat = statSync(path.join(directory, name));
              return {
                name,
                createdAt: stat.birthtime.toISOString(),
                size: stat.size,
              };
            })
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        : [],
    );
  });
  router.post("/backups", async (req, res) =>
    res
      .status(201)
      .json(await createBackup(store, passwordSchema.parse(req.body.password))),
  );
  router.post(
    "/backups/restore",
    multer({
      storage: multer.memoryStorage(),
      limits: { files: 1, fileSize: 200 * 1024 * 1024, fields: 1 },
    }).single("file"),
    async (req, res) => {
      if (!req.file) throw new AppError(400, "Select an encrypted backup.");
      res.json(
        await prepareRestore(
          store,
          queue,
          JSON.parse(req.file.buffer.toString()),
          passwordSchema.parse(req.body.password),
        ),
      );
    },
  );
  router.get("/backups/:name", (req, res) => {
    const name = String(req.params.name);
    if (!safeBackup(name)) throw new AppError(400, "Invalid backup name.");
    const target = path.join(store.dataDir, "backups", name);
    if (!existsSync(target)) throw new AppError(404, "Backup not found.");
    res.download(target, name);
  });
  router.get("/languages", (_req, res) => {
    const directory = path.join(store.dataDir, "languages");
    res.json([
      ...new Set([
        "eng",
        ...(existsSync(directory)
          ? readdirSync(directory)
              .filter((name) => name.endsWith(".traineddata.gz"))
              .map((name) => name.replace(".traineddata.gz", ""))
          : []),
      ]),
    ]);
  });
  router.post("/languages/:code", async (req, res) => {
    const code = z
      .string()
      .regex(/^[a-z_]{3,20}$/)
      .parse(req.params.code);
    if (code === "eng") {
      res.json({ ok: true });
      return;
    }
    const response = await fetch(
      `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/${code}.traineddata`,
      { signal: AbortSignal.timeout(120000), redirect: "error" },
    );
    if (!response.ok)
      throw new AppError(400, "The requested language pack is unavailable.");
    let data: Buffer;
    try {
      data = await readLimitedBody(response, 50 * 1024 * 1024);
    } catch (error) {
      if (error instanceof ResponseLimitError)
        throw new AppError(413, "Language model exceeds the download limit.");
      throw error;
    }
    const directory = path.join(store.dataDir, "languages");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, `${code}.traineddata.gz`),
      gzipSync(data),
      { mode: 0o600 },
    );
    res.json({ ok: true });
  });
  router.get("/network", (_req, res) =>
    res.json({ proxyConfigured: Boolean(store.setting("proxy")) }),
  );
  router.put("/network", (req, res) => {
    const value = z.object({ proxyUrl: z.string().max(2000) }).parse(req.body);
    if (
      value.proxyUrl &&
      !["http:", "https:"].includes(new URL(value.proxyUrl).protocol)
    )
      throw new AppError(400, "Use an HTTP(S) proxy URL.");
    store.setSetting(
      "proxy",
      value.proxyUrl ? store.encrypt({ url: value.proxyUrl }) : null,
    );
    res.json({ ok: true });
  });
  return router;
}
