import { expect, test } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createCanvas } from "@napi-rs/canvas";
import { Store } from "./store.js";
import { JobQueue } from "./jobs.js";
import { saveDocument } from "./documents.js";
import {
  seal,
  unseal,
  createBackup,
  prepareRestore,
  applyPendingRestore,
} from "./operations.js";
test("backup envelopes authenticate their password and detect tampering", () => {
  const envelope = seal({ text: "confidential fixture" }, "test-password-2026");
  expect(JSON.stringify(envelope)).not.toContain("confidential fixture");
  expect(unseal(envelope, "test-password-2026")).toEqual({
    text: "confidential fixture",
  });
  expect(() => unseal(envelope, "wrong-password")).toThrow();
  expect(() =>
    unseal({ ...envelope, data: envelope.data.slice(4) }, "test-password-2026"),
  ).toThrow();
});
test("encrypted backup restores documents and rekeys credentials for the current installation", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "freeocrapi-backup-"));
  let store = new Store(directory);
  const queue = new JobQueue(store);
  try {
    const credential = randomUUID();
    store.db
      .prepare(
        "INSERT INTO credentials(id,engine,label,secret) VALUES(?,?,?,?)",
      )
      .run(
        credential,
        "mistral",
        "Backup fixture",
        store.encrypt({ apiKey: "not-a-real-key" }),
      );
    const canvas = createCanvas(40, 40);
    const file = await saveDocument(
      store,
      "backed-up.png",
      canvas.toBuffer("image/png"),
    );
    const archive = await createBackup(store, "backup-password-2026");
    const envelope = JSON.parse(
      readFileSync(path.join(directory, "backups", archive.name), "utf8"),
    );
    store.db.prepare("DELETE FROM credentials WHERE id=?").run(credential);
    await prepareRestore(store, queue, envelope, "backup-password-2026");
    store.close();
    applyPendingRestore(directory);
    store = new Store(directory);
    expect(
      store.db.prepare("SELECT name FROM files WHERE id=?").get(file.id)?.name,
    ).toBe("backed-up.png");
    const row = store.db
      .prepare("SELECT secret FROM credentials WHERE id=?")
      .get(credential);
    expect(store.decrypt(String(row?.secret)).apiKey).toBe("not-a-real-key");
    expect(store.setting("restorePending")).toBeUndefined();
  } finally {
    await queue.close();
    store.close();
    if (
      path.dirname(directory) !== tmpdir() ||
      !path.basename(directory).startsWith("freeocrapi-backup-")
    )
      throw new Error("Unsafe cleanup");
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);
