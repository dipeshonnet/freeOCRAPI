import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHash,
} from "node:crypto";
import { catalog } from "./catalog.js";

export class Store {
  readonly db: DatabaseSync;
  readonly dataDir: string;
  private key: Buffer;
  constructor(dataDir = path.resolve(process.env.DATA_DIR || "data")) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
    const supplied = process.env.ENCRYPTION_KEY;
    if (supplied && !/^[a-fA-F0-9]{64}$/.test(supplied))
      throw new Error(
        "ENCRYPTION_KEY must contain exactly 64 hexadecimal characters",
      );
    if (process.env.NODE_ENV === "production" && !supplied)
      throw new Error("ENCRYPTION_KEY is required in production");
    const keyFile = path.join(dataDir, ".encryption-key");
    if (!supplied && !existsSync(keyFile))
      writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: "wx" });
    this.key = supplied ? Buffer.from(supplied, "hex") : readFileSync(keyFile);
    if (this.key.length !== 32)
      throw new Error(
        "Stored encryption key is invalid; restore the original key",
      );
    this.db = new DatabaseSync(path.join(dataDir, "freeocrapi.db"));
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    `);
    const current = this.db
      .prepare("SELECT MAX(version) AS version FROM migrations")
      .get() as { version: number | null };
    if (!current.version) {
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE users(id INTEGER PRIMARY KEY CHECK(id=1),email TEXT NOT NULL,password TEXT NOT NULL);
        CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
        CREATE TABLE resets(code_hash TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
        CREATE TABLE engines(id TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 1,priority INTEGER NOT NULL);
        CREATE TABLE credentials(id TEXT PRIMARY KEY,engine TEXT NOT NULL REFERENCES engines(id),label TEXT NOT NULL,secret TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'unknown',checked_at TEXT,request_cap INTEGER NOT NULL DEFAULT 0,page_cap INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE profiles(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,engines TEXT NOT NULL,strategy TEXT NOT NULL);
        INSERT INTO migrations VALUES(1,datetime('now')); COMMIT;`);
    }
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO engines(id,priority) VALUES(?,?)",
    );
    this.migrate(
      2,
      `CREATE TABLE files(id TEXT PRIMARY KEY,name TEXT NOT NULL,mime TEXT NOT NULL,format TEXT NOT NULL,size INTEGER NOT NULL,pages INTEGER NOT NULL,sha256 TEXT NOT NULL,created_at TEXT NOT NULL);`,
    );
    this.migrate(
      3,
      `CREATE TABLE jobs(id TEXT PRIMARY KEY,file_id TEXT NOT NULL REFERENCES files(id),engine TEXT NOT NULL,requested_engine TEXT NOT NULL,profile TEXT NOT NULL,options TEXT NOT NULL,status TEXT NOT NULL,result TEXT,error TEXT,batch_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,progress INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE attempts(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,engine TEXT NOT NULL,credential_id TEXT,status TEXT NOT NULL,operation TEXT,error TEXT,pages INTEGER,credits REAL,reserved_pages INTEGER NOT NULL,started_at TEXT NOT NULL,ended_at TEXT,duration_ms INTEGER);
      CREATE INDEX attempts_usage ON attempts(credential_id,started_at,status);
      CREATE TABLE cooldowns(scope TEXT PRIMARY KEY,until_at INTEGER NOT NULL);
      CREATE TABLE cache(key TEXT PRIMARY KEY,result TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX jobs_status ON jobs(status,created_at);`,
    );
    this.migrate(
      4,
      `CREATE TABLE monthly_usage(credential_id TEXT NOT NULL,engine TEXT NOT NULL,month TEXT NOT NULL,requests INTEGER NOT NULL DEFAULT 0,pages INTEGER NOT NULL DEFAULT 0,credits REAL NOT NULL DEFAULT 0,PRIMARY KEY(credential_id,month));
      INSERT INTO monthly_usage SELECT COALESCE(credential_id,'local:'||engine),engine,substr(started_at,1,7),COUNT(*),COALESCE(SUM(pages),0),COALESCE(SUM(credits),0) FROM attempts WHERE status='succeeded' GROUP BY COALESCE(credential_id,'local:'||engine),engine,substr(started_at,1,7);`,
    );
    catalog.forEach((engine, i) => insert.run(engine.id, i));
    if (!this.setting("unifiedKey"))
      this.setSetting(
        "unifiedKey",
        this.encrypt({
          value: `freeocrapi-${randomBytes(24).toString("hex")}`,
        }),
      );
    if (!this.setting("routing"))
      this.setSetting("routing", {
        strategy: "balanced",
        weights: { reliability: 0.5, speed: 0.25, quality: 0.25 },
      });
    if (!this.setting("preferences"))
      this.setSetting("preferences", {
        retentionDays: 30,
        cacheEnabled: false,
        language: "en",
        maxPages: 100,
        maxFileMB: 50,
        defaultLanguage: "eng",
      });
    if (!this.db.prepare("SELECT id FROM profiles LIMIT 1").get())
      this.db
        .prepare("INSERT INTO profiles VALUES(?,?,?,?)")
        .run(
          "default",
          "Default",
          JSON.stringify(catalog.map((e) => e.id)),
          "balanced",
        );
  }
  migrate(version: number, sql: string) {
    if (
      this.db
        .prepare("SELECT version FROM migrations WHERE version=?")
        .get(version)
    )
      return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(sql);
      this.db
        .prepare("INSERT INTO migrations VALUES(?,?)")
        .run(version, new Date().toISOString());
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  setting<T = unknown>(key: string): T | undefined {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  setSetting(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  encrypt(value: unknown) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(value)),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      "base64",
    );
  }
  decrypt<T = Record<string, string>>(value: string): T {
    const data = Buffer.from(value, "base64");
    const cipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      data.subarray(0, 12),
    );
    cipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([
        cipher.update(data.subarray(28)),
        cipher.final(),
      ]).toString(),
    );
  }
  unifiedKey() {
    return this.decrypt<{ value: string }>(this.setting<string>("unifiedKey")!)
      .value;
  }
  hasUser() {
    return Boolean(this.db.prepare("SELECT id FROM users").get());
  }
  close() {
    this.db.close();
    this.key.fill(0);
  }
}
export const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
