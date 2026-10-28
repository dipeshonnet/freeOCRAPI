import { Router } from "express";
import { randomUUID, randomBytes } from "node:crypto";
import { z } from "zod";
import { Store } from "./store.js";
import { catalog } from "./catalog.js";
import { localReady } from "./documents.js";

export const credentialSchema = z.object({
  engine: z.enum(catalog.map((e) => e.id) as [string, ...string[]]),
  label: z.string().trim().min(1).max(120),
  secret: z.record(z.string().max(32000)),
  requestCap: z.number().int().min(0).default(0),
  pageCap: z.number().int().min(0).default(0),
});
export function credentialRows(store: Store) {
  return store.db
    .prepare(
      "SELECT id,engine,label,enabled,status,checked_at AS checkedAt,request_cap AS requestCap,page_cap AS pageCap FROM credentials",
    )
    .all()
    .map((row) => ({ ...row, enabled: Boolean(row.enabled) }));
}
export function engineRows(store: Store) {
  return catalog
    .map((def) => {
      const state = store.db
        .prepare("SELECT enabled,priority FROM engines WHERE id=?")
        .get(def.id) as { enabled: number; priority: number };
      const keys = store.db
        .prepare("SELECT status FROM credentials WHERE engine=? AND enabled=1")
        .all(def.id);
      const builtin = def.id === "tesseract" && localReady();
      const stats = store.db
        .prepare(
          "SELECT COUNT(*) AS total,SUM(status='succeeded') AS successes,SUM(status IN ('succeeded','failed')) AS known,COALESCE(SUM(pages),0) AS pages,AVG(CASE WHEN status='succeeded' THEN duration_ms END) AS latency FROM attempts WHERE engine=? AND started_at>=?",
        )
        .get(
          def.id,
          new Date().toISOString().slice(0, 7) + "-01T00:00:00.000Z",
        )!;
      return {
        ...def,
        ...state,
        enabled: Boolean(state.enabled),
        configured: builtin || keys.length > 0,
        status: builtin
          ? "ready"
          : keys.length
            ? keys.some((k) => k.status === "healthy")
              ? "healthy"
              : "unknown"
            : "unconfigured",
        pagesUsed: Number(stats.pages),
        pageLimit: null,
        requests: Number(stats.total),
        reliability: Number(stats.known)
          ? Number(stats.successes) / Number(stats.known)
          : null,
        latencyMs: stats.latency === null ? null : Number(stats.latency),
      };
    })
    .sort((a, b) => Number(a.priority) - Number(b.priority));
}
export function adminRoutes(store: Store) {
  const router = Router();
  router.get("/models", (_req, res) => res.json(engineRows(store)));
  router.patch("/models/:id", (req, res) => {
    const value = z
      .object({
        enabled: z.boolean().optional(),
        priority: z.number().int().min(0).optional(),
      })
      .parse(req.body);
    const engine = catalog.find((e) => e.id === req.params.id);
    if (!engine) {
      res.sendStatus(404);
      return;
    }
    if (value.enabled !== undefined)
      store.db
        .prepare("UPDATE engines SET enabled=? WHERE id=?")
        .run(Number(value.enabled), engine.id);
    if (value.priority !== undefined)
      store.db
        .prepare("UPDATE engines SET priority=? WHERE id=?")
        .run(value.priority, engine.id);
    res.json({ ok: true });
  });
  router.get("/keys", (_req, res) => res.json(credentialRows(store)));
  router.post("/keys", (req, res) => {
    const value = credentialSchema.parse(req.body);
    const definition = catalog.find((e) => e.id === value.engine)!;
    for (const field of definition.credentialFields)
      if (!value.secret[field]?.trim()) {
        res.status(400).json({
          error: { message: `${field} is required for ${definition.name}` },
        });
        return;
      }
    const id = randomUUID();
    store.db
      .prepare(
        "INSERT INTO credentials(id,engine,label,secret,request_cap,page_cap) VALUES(?,?,?,?,?,?)",
      )
      .run(
        id,
        value.engine,
        value.label,
        store.encrypt(value.secret),
        value.requestCap,
        value.pageCap,
      );
    res.status(201).json({ id });
  });
  router.patch("/keys/:id", (req, res) => {
    const value = z
      .object({
        enabled: z.boolean().optional(),
        requestCap: z.number().int().min(0).optional(),
        pageCap: z.number().int().min(0).optional(),
        label: z.string().trim().min(1).max(120).optional(),
      })
      .parse(req.body);
    const mapping = {
      enabled: "enabled",
      requestCap: "request_cap",
      pageCap: "page_cap",
      label: "label",
    };
    const pairs = Object.entries(value);
    if (pairs.length)
      store.db
        .prepare(
          `UPDATE credentials SET ${pairs.map(([key]) => `${mapping[key as keyof typeof mapping]}=?`).join(",")} WHERE id=?`,
        )
        .run(
          ...pairs.map(([key, v]) =>
            key === "enabled" ? Number(v) : (v as string | number),
          ),
          String(req.params.id),
        );
    res.json({ ok: true });
  });
  router.delete("/keys/:id", (req, res) => {
    store.db
      .prepare("DELETE FROM credentials WHERE id=?")
      .run(String(req.params.id));
    res.json({ ok: true });
  });
  router.get("/settings", (_req, res) =>
    res.json({
      preferences: store.setting("preferences"),
      routing: store.setting("routing"),
    }),
  );
  router.put("/settings", (req, res) => {
    const value = z
      .object({
        preferences: z
          .object({
            retentionDays: z.number().int().min(1).max(3650),
            cacheEnabled: z.boolean(),
            language: z.string().max(20),
            maxPages: z.number().int().min(1).max(10000),
            maxFileMB: z.number().int().min(1).max(500),
            defaultLanguage: z
              .string()
              .regex(/^[a-z_+]+$/)
              .max(80),
          })
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
    if (value.preferences) store.setSetting("preferences", value.preferences);
    if (value.routing) {
      store.setSetting("routing", value.routing);
      store.db
        .prepare("UPDATE profiles SET strategy=? WHERE id='default'")
        .run(value.routing.strategy);
    }
    res.json({ ok: true });
  });
  router.get("/settings/api-key", (_req, res) =>
    res.json({ apiKey: store.unifiedKey() }),
  );
  router.post("/settings/api-key/rotate", (_req, res) => {
    store.setSetting(
      "unifiedKey",
      store.encrypt({ value: `freeocrapi-${randomBytes(24).toString("hex")}` }),
    );
    res.json({ apiKey: store.unifiedKey() });
  });
  router.get("/profiles", (_req, res) =>
    res.json(
      store.db
        .prepare("SELECT * FROM profiles")
        .all()
        .map((row) => ({ ...row, engines: JSON.parse(String(row.engines)) })),
    ),
  );
  router.put("/profiles/:id", (req, res) => {
    const value = z
      .object({
        name: z.string().trim().min(1).max(100),
        engines: z
          .array(z.enum(catalog.map((e) => e.id) as [string, ...string[]]))
          .max(100),
        strategy: z.enum([
          "manual",
          "balanced",
          "quality",
          "fastest",
          "reliable",
          "custom",
        ]),
      })
      .parse(req.body);
    store.db
      .prepare(
        "INSERT INTO profiles VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,engines=excluded.engines,strategy=excluded.strategy",
      )
      .run(
        String(req.params.id),
        value.name,
        JSON.stringify([...new Set(value.engines)]),
        value.strategy,
      );
    if (req.params.id === "default")
      store.setSetting("routing", {
        ...store.setting<object>("routing"),
        strategy: value.strategy,
      });
    res.json({ ok: true });
  });
  router.delete("/profiles/:id", (req, res) => {
    if (
      store.db
        .prepare(
          "SELECT id FROM jobs WHERE profile=? AND status IN ('queued','running') LIMIT 1",
        )
        .get(String(req.params.id)) ||
      (store.setting<{ profile: string }[]>("rules") || []).some(
        (rule) => rule.profile === req.params.id,
      )
    ) {
      res
        .status(409)
        .json({
          error: {
            message: "This profile is used by a routing rule or active job.",
          },
        });
      return;
    }
    if (req.params.id === "default") {
      res
        .status(400)
        .json({ error: { message: "The default profile cannot be deleted." } });
      return;
    }
    store.db
      .prepare("DELETE FROM profiles WHERE id=?")
      .run(String(req.params.id));
    res.json({ ok: true });
  });
  router.get("/catalog", (_req, res) =>
    res.json({
      version: 1,
      source: "bundled",
      engines: catalog,
      updateChannel: null,
    }),
  );
  router.get("/analytics", (req, res) => {
    const range = z
      .enum(["24h", "7d", "30d", "90d"])
      .parse(req.query.range || "7d");
    const days = range === "24h" ? 1 : Number.parseInt(range);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const summary = store.db
      .prepare(
        "SELECT COUNT(*) AS documents,SUM(status='succeeded') AS successes,SUM(status IN ('failed','needs_attention')) AS failures FROM jobs WHERE created_at>=?",
      )
      .get(since)!;
    const usage = store.db
      .prepare(
        "SELECT COALESCE(SUM(pages),0) AS pages,COUNT(*) AS attempts,AVG(CASE WHEN status='succeeded' THEN duration_ms END) AS latency FROM attempts WHERE started_at>=?",
      )
      .get(since)!;
    const bucket =
      range === "24h" ? "substr(created_at,1,13)" : "substr(created_at,1,10)";
    const timeline = store.db
      .prepare(
        `SELECT ${bucket} AS date,COUNT(*) AS requests,SUM(status='succeeded') AS success,SUM(status IN ('failed','needs_attention')) AS failures FROM jobs WHERE created_at>=? GROUP BY ${bucket} ORDER BY date`,
      )
      .all(since);
    const byEngine = store.db
      .prepare(
        "SELECT engine,COUNT(*) AS attempts,COALESCE(SUM(pages),0) AS pages,SUM(status='succeeded') AS successes,AVG(duration_ms) AS latency FROM attempts WHERE started_at>=? GROUP BY engine",
      )
      .all(since);
    res.json({ summary: { ...summary, ...usage }, timeline, byEngine });
  });
  router.get("/logs", (req, res) => {
    const q = String(req.query.q || "").slice(0, 200);
    res.json(
      store.db
        .prepare(
          "SELECT j.id,j.engine,j.status,j.error,j.created_at AS createdAt,j.updated_at AS updatedAt,f.name AS filename,j.progress FROM jobs j JOIN files f ON f.id=j.file_id WHERE f.name LIKE ? OR j.id LIKE ? OR j.error LIKE ? ORDER BY j.created_at DESC LIMIT 200",
        )
        .all(`%${q}%`, `%${q}%`, `%${q}%`),
    );
  });
  router.get("/documents", (req, res) => {
    const q = String(req.query.q || "").slice(0, 200);
    res.json(
      store.db
        .prepare(
          "SELECT j.id,j.engine,j.created_at AS createdAt,f.name AS filename,substr(json_extract(j.result,'$.text'),1,300) AS excerpt FROM jobs j JOIN files f ON f.id=j.file_id WHERE j.status='succeeded' AND (f.name LIKE ? OR json_extract(j.result,'$.text') LIKE ?) ORDER BY j.created_at DESC LIMIT 100",
        )
        .all(`%${q}%`, `%${q}%`),
    );
  });
  router.get("/rules", (_req, res) => res.json(store.setting("rules") || []));
  router.put("/rules", (req, res) => {
    const value = z
      .array(
        z.object({
          id: z.string().uuid(),
          format: z.enum(["any", "pdf", "png", "jpeg", "webp", "tiff"]),
          minPages: z.number().int().min(1),
          profile: z.string().max(100),
        }),
      )
      .max(100)
      .parse(req.body);
    for (const rule of value)
      if (
        !store.db
          .prepare("SELECT id FROM profiles WHERE id=?")
          .get(rule.profile)
      )
        throw new Error("Invalid routing profile");
    store.setSetting("rules", value);
    res.json({ ok: true });
  });
  return router;
}
