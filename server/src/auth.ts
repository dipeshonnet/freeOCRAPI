import { Router, type RequestHandler } from "express";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Store, hash } from "./store.js";

const credentials = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(12).max(256),
  setupCode: z.string().optional(),
});
export function passwordHash(value: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(value, salt, 64).toString("hex")}`;
}
export function passwordMatches(value: string, encoded: string) {
  const [salt, expected] = encoded.split(":");
  const actual = scryptSync(value, salt, 64);
  const wanted = Buffer.from(expected, "hex");
  return wanted.length === actual.length && timingSafeEqual(actual, wanted);
}
export function session(store: Store) {
  const token = randomBytes(32).toString("hex");
  store.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
  store.db
    .prepare("INSERT INTO sessions VALUES(?,?)")
    .run(hash(token), Date.now() + 7 * 86400000);
  return token;
}
export function requireAuth(store: Store, allowApi = false): RequestHandler {
  return (req, res, next) => {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
    const row = store.db
      .prepare(
        "SELECT token_hash FROM sessions WHERE token_hash=? AND expires_at>?",
      )
      .get(hash(token), Date.now());
    if (
      row ||
      (allowApi && token && hash(token) === hash(store.unifiedKey()))
    ) {
      next();
      return;
    }
    res.status(401).json({
      error: {
        code: "unauthorized",
        message: "Sign in or supply a valid bearer token.",
      },
    });
  };
}
export function authRoutes(store: Store) {
  const router = Router();
  const setupCode = randomBytes(18).toString("hex");
  const attempts = new Map<string, { count: number; reset: number }>();
  router.get("/status", (_req, res) =>
    res.json({ setupRequired: !store.hasUser() }),
  );
  router.post("/desktop", (req, res) => {
    const expected = process.env.FREEOCRAPI_DESKTOP_TOKEN;
    const supplied = req.headers["x-freeocrapi-desktop"];
    const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
      req.socket.remoteAddress || "",
    );
    if (
      !expected ||
      typeof supplied !== "string" ||
      !local ||
      supplied.length !== expected.length ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    ) {
      res
        .status(403)
        .json({ error: { message: "Desktop sign-in is unavailable." } });
      return;
    }
    if (!store.hasUser())
      store.db
        .prepare("INSERT INTO users VALUES(1,?,?)")
        .run(
          "desktop@freeocrapi.local",
          passwordHash(randomBytes(32).toString("hex")),
        );
    res.json({ token: session(store) });
  });
  router.use((req, res, next) => {
    const key = req.ip || "unknown";
    const now = Date.now();
    let entry = attempts.get(key);
    if (!entry || entry.reset < now) {
      entry = { count: 0, reset: now + 60000 };
      attempts.set(key, entry);
    }
    if (++entry.count > 12) {
      res.setHeader("Retry-After", "60");
      res.status(429).json({
        error: { message: "Too many attempts. Try again in a minute." },
      });
      return;
    }
    if (attempts.size > 1000)
      for (const [ip, value] of attempts)
        if (value.reset < now) attempts.delete(ip);
    next();
  });
  router.post("/setup", (req, res) => {
    if (store.hasUser()) {
      res.status(409).json({
        error: { message: "This installation already has an account." },
      });
      return;
    }
    const value = credentials.parse(req.body);
    const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
      req.socket.remoteAddress || "",
    );
    if (!local && value.setupCode !== setupCode) {
      res.status(403).json({
        error: { message: "Read the setup code from the server console." },
      });
      return;
    }
    store.db
      .prepare("INSERT INTO users VALUES(1,?,?)")
      .run(value.email.toLowerCase(), passwordHash(value.password));
    res.status(201).json({ token: session(store) });
  });
  router.post("/login", (req, res) => {
    const value = z
      .object({ email: z.string().max(254), password: z.string().max(256) })
      .parse(req.body);
    const user = store.db
      .prepare("SELECT email,password FROM users WHERE id=1")
      .get() as { email: string; password: string } | undefined;
    // Always perform a password hash even when the account is missing.
    const valid = passwordMatches(
      value.password,
      user?.password || passwordHash("unavailable-account"),
    );
    if (!user || user.email !== value.email.trim().toLowerCase() || !valid) {
      res
        .status(401)
        .json({ error: { message: "Email or password is incorrect." } });
      return;
    }
    res.json({ token: session(store) });
  });
  router.post("/logout", requireAuth(store), (req, res) => {
    store.db
      .prepare("DELETE FROM sessions WHERE token_hash=?")
      .run(hash(req.headers.authorization!.replace(/^Bearer\s+/i, "")));
    res.json({ ok: true });
  });
  router.post("/forgot-password", (_req, res) => {
    if (store.hasUser()) {
      const code = randomBytes(6).toString("hex");
      store.db.exec("DELETE FROM resets");
      store.db
        .prepare("INSERT INTO resets VALUES(?,?)")
        .run(hash(code), Date.now() + 15 * 60000);
      console.log(`FreeOCRapi password reset code (15 minutes): ${code}`);
    }
    res.json({
      message:
        "If an account exists, a reset code was printed to the server console.",
    });
  });
  router.post("/reset-password", (req, res) => {
    const value = z
      .object({
        code: z.string().max(100),
        password: z.string().min(12).max(256),
      })
      .parse(req.body);
    if (
      !store.db
        .prepare(
          "SELECT code_hash FROM resets WHERE code_hash=? AND expires_at>?",
        )
        .get(hash(value.code), Date.now())
    ) {
      res
        .status(400)
        .json({ error: { message: "Reset code is invalid or expired." } });
      return;
    }
    store.db
      .prepare("UPDATE users SET password=? WHERE id=1")
      .run(passwordHash(value.password));
    store.db.exec("DELETE FROM sessions; DELETE FROM resets;");
    res.json({ token: session(store) });
  });
  router.put("/account", requireAuth(store), (req, res) => {
    const value = credentials
      .extend({ currentPassword: z.string().max(256) })
      .parse(req.body);
    const user = store.db
      .prepare("SELECT password FROM users WHERE id=1")
      .get() as { password: string };
    if (!passwordMatches(value.currentPassword, user.password)) {
      res
        .status(403)
        .json({ error: { message: "Current password is incorrect." } });
      return;
    }
    store.db
      .prepare("UPDATE users SET email=?,password=? WHERE id=1")
      .run(value.email.toLowerCase(), passwordHash(value.password));
    store.db.exec("DELETE FROM sessions");
    res.json({ token: session(store) });
  });
  if (!store.hasUser() && process.env.HOST && process.env.HOST !== "127.0.0.1")
    console.log(`FreeOCRapi remote setup code: ${setupCode}`);
  return router;
}
