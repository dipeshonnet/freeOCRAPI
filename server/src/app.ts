import express from "express";
import helmet from "helmet";
import path from "node:path";
import { existsSync } from "node:fs";
import { ZodError } from "zod";
import { Store } from "./store.js";
import { authRoutes, requireAuth } from "./auth.js";
import { adminRoutes } from "./admin.js";
import { AppError } from "./errors.js";
import multer from "multer";
import { fileRoutes } from "./files.js";
import { JobQueue, jobRoutes } from "./jobs.js";
import { engineRows } from "./admin.js";
import { operationRoutes } from "./operations.js";
import { docsRoutes, mcpRoutes } from "./public-api.js";
export function createApp(store = new Store(), queue = new JobQueue(store)) {
  const app = express();
  app.disable("x-powered-by");
  const allowedHosts = new Set([
    "localhost",
    "127.0.0.1",
    "[::1]",
    ...(process.env.ALLOWED_HOSTS || "").split(",").filter(Boolean),
  ]);
  app.use((req, res, next) => {
    if (!allowedHosts.has(req.hostname)) {
      res.status(403).json({
        error: {
          message:
            "Host is not allowed. Configure ALLOWED_HOSTS for LAN access.",
        },
      });
      return;
    }
    next();
  });
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "img-src": ["'self'", "data:", "blob:"],
          "worker-src": ["'self'", "blob:"],
          "frame-src": ["'self'", "blob:"],
        },
      },
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.use((req, res, next) => {
    if (req.method !== "GET" && store.setting("restorePending")) {
      res
        .status(409)
        .json({
          error: {
            message:
              "Restore is prepared. Restart FreeOCRapi before making further changes.",
          },
        });
      return;
    }
    next();
  });
  app.get("/health", (_req, res) =>
    res.json({ status: "ok", app: "FreeOCRapi", version: "0.1.0" }),
  );
  app.use("/api/auth", authRoutes(store));
  app.use("/v1", docsRoutes());
  app.use("/mcp", requireAuth(store, true), mcpRoutes(store, queue));
  app.use("/v1", requireAuth(store, true), fileRoutes(store));
  app.get("/v1/models", requireAuth(store, true), (_req, res) =>
    res.json({ data: engineRows(store) }),
  );
  app.use("/v1", requireAuth(store, true), jobRoutes(queue));
  app.locals.queue = queue;
  app.locals.store = store;
  app.use("/api", requireAuth(store), adminRoutes(store));
  app.use("/api", requireAuth(store), operationRoutes(store, queue));
  app.use("/v1", (_req, res) =>
    res
      .status(404)
      .json({
        error: {
          code: "not_found",
          message: "Unknown processing API endpoint.",
        },
      }),
  );
  app.use("/api", (_req, res) =>
    res
      .status(404)
      .json({ error: { code: "not_found", message: "Unknown API endpoint." } }),
  );
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (err instanceof AppError) {
        res
          .status(err.status)
          .json({ error: { code: err.code, message: err.message } });
        return;
      }
      if (err instanceof multer.MulterError) {
        res
          .status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400)
          .json({ error: { code: err.code, message: err.message } });
        return;
      }
      if (err instanceof ZodError) {
        res.status(400).json({
          error: {
            code: "validation_error",
            message: err.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; "),
          },
        });
        return;
      }
      if (err instanceof SyntaxError) {
        res.status(400).json({ error: { message: "Invalid JSON." } });
        return;
      }
      res
        .status(500)
        .json({ error: { message: "The operation could not be completed." } });
    },
  );
  const dist = path.resolve("client/dist");
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get("/{*path}", (_req, res) =>
      res.sendFile(path.join(dist, "index.html")),
    );
  }
  return app;
}
