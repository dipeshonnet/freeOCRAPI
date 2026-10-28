import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createCanvas } from "@napi-rs/canvas";
import { Store } from "./store.js";
import { saveDocument } from "./documents.js";
import { JobQueue } from "./jobs.js";
import { providers, ProviderError, type Provider } from "./providers.js";
import type { OcrResult } from "../../shared/types.js";
import { runRetention } from "./operations.js";
const fixtures: { store: Store; queue: JobQueue }[] = [];
const originals = new Map(providers);
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.queue.close();
    fixture.store.close();
    const dir = fixture.store.dataDir;
    if (
      path.dirname(dir) !== tmpdir() ||
      !path.basename(dir).startsWith("freeocrapi-job-")
    )
      throw new Error("Unsafe cleanup");
    rmSync(dir, { recursive: true, force: true });
  }
  providers.clear();
  for (const [key, value] of originals) providers.set(key, value);
});
const result = (engine: string): OcrResult => ({
  engine,
  provider: engine,
  text: "verified",
  markdown: "verified",
  pages: [
    {
      number: 1,
      text: "verified",
      markdown: "verified",
      blocks: [],
      tables: [],
    },
  ],
  usage: { pages: 1, credits: null },
});
async function setup() {
  const store = new Store(mkdtempSync(path.join(tmpdir(), "freeocrapi-job-")));
  store.setSetting("routing", {
    strategy: "manual",
    weights: { reliability: 0.5, speed: 0.25, quality: 0.25 },
  });
  const canvas = createCanvas(100, 100);
  const file = await saveDocument(
    store,
    "fixture.png",
    canvas.toBuffer("image/png"),
  );
  const queue = new JobQueue(store);
  fixtures.push({ store, queue });
  return { store, file, queue };
}
async function completed(queue: JobQueue, id: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const job = queue.get(id);
    if (!["running", "queued"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Job did not finish");
}
function key(store: Store, id = "test-key", cap = 0) {
  store.db
    .prepare(
      "INSERT INTO credentials(id,engine,label,secret,request_cap) VALUES(?,?,?,?,?)",
    )
    .run(id, "mistral", "Fixture", store.encrypt({ apiKey: "fixture" }), cap);
}
test("one active engine at a time with safe sequential failover and persisted result", async () => {
  const { store, file, queue } = await setup();
  key(store);
  let active = 0;
  let maximum = 0;
  const run: Provider = async (context) => {
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setTimeout(resolve, 25));
    --active;
    if (!context.secret.apiKey)
      throw new ProviderError("Confirmed rejection", true);
    return result("mistral");
  };
  providers.set("tesseract", run);
  providers.set("mistral", run);
  const a = queue.submit({ fileId: file.id });
  const b = queue.submit({ fileId: file.id });
  expect((await completed(queue, a.id)).engine).toBe("mistral");
  expect((await completed(queue, b.id)).status).toBe("succeeded");
  expect(maximum).toBe(1);
  expect(
    store.db
      .prepare("SELECT COUNT(*) AS n FROM attempts WHERE status='succeeded'")
      .get()?.n,
  ).toBe(2);
});
test("uncertain submission prevents fallback and retains a needs-attention checkpoint", async () => {
  const { store, file, queue } = await setup();
  key(store);
  providers.set("tesseract", async () => {
    throw new ProviderError("Rejected", true);
  });
  providers.set("mistral", async () => {
    throw new ProviderError("Submission timed out");
  });
  const job = await completed(queue, queue.submit({ fileId: file.id }).id);
  expect(job.status).toBe("needs_attention");
  expect(
    store.db.prepare("SELECT status FROM attempts WHERE engine='mistral'").get()
      ?.status,
  ).toBe("unknown");
});
test("pinned engine obeys monthly cap and cached jobs do not create extra attempts", async () => {
  const { store, file, queue } = await setup();
  key(store, "test-key", 1);
  providers.set("mistral", async () => result("mistral"));
  expect(
    (
      await completed(
        queue,
        queue.submit({ fileId: file.id, engine: "mistral" }).id,
      )
    ).status,
  ).toBe("succeeded");
  expect(
    (
      await completed(
        queue,
        queue.submit({ fileId: file.id, engine: "mistral" }).id,
      )
    ).status,
  ).toBe("failed");
  providers.set("tesseract", async () => result("tesseract"));
  store.setSetting("preferences", {
    ...store.setting<object>("preferences"),
    cacheEnabled: true,
  });
  await completed(
    queue,
    queue.submit({ fileId: file.id, engine: "tesseract" }).id,
  );
  const cached = await completed(
    queue,
    queue.submit({ fileId: file.id, engine: "tesseract" }).id,
  );
  expect((cached.result as OcrResult).cached).toBe(true);
  expect(cached.engine).toBe("tesseract");
});
test("queued cancellation never dispatches and restart flags remote uncertain work", async () => {
  const { store, file, queue } = await setup();
  const job = queue.submit({ fileId: file.id });
  queue.cancel(job.id);
  expect(queue.get(job.id).status).toBe("cancelled");
  await queue.close();
  store.db
    .prepare("UPDATE jobs SET status='running',engine='mistral' WHERE id=?")
    .run(job.id);
  store.db
    .prepare(
      "INSERT INTO attempts(id,job_id,engine,status,reserved_pages,started_at) VALUES(?,?,?,?,?,?)",
    )
    .run(
      "interrupted",
      job.id,
      "mistral",
      "running",
      1,
      new Date().toISOString(),
    );
  const restarted = new JobQueue(store);
  expect(restarted.get(job.id).status).toBe("needs_attention");
  await restarted.close();
});
test("history retention does not reset monthly credential caps", async () => {
  const { store, file, queue } = await setup();
  key(store, "retained-cap", 1);
  providers.set("mistral", async () => result("mistral"));
  const first = await completed(
    queue,
    queue.submit({ fileId: file.id, engine: "mistral" }).id,
  );
  expect(first.status).toBe("succeeded");
  store.db
    .prepare("UPDATE jobs SET updated_at=? WHERE id=?")
    .run("2000-01-01T00:00:00.000Z", first.id);
  runRetention(store);
  expect(
    store.db.prepare("SELECT id FROM jobs WHERE id=?").get(first.id),
  ).toBeUndefined();
  expect(
    (
      await completed(
        queue,
        queue.submit({ fileId: file.id, engine: "mistral" }).id,
      )
    ).status,
  ).toBe("failed");
});
test("resumes an existing provider operation without creating a second submission", async () => {
  const { store, file, queue } = await setup();
  key(store);
  let submissions = 0;
  providers.set("mistral", async (context) => {
    if (context.operation) return result("mistral");
    submissions++;
    context.onOperation("saved-provider-operation");
    throw new ProviderError("Polling interrupted");
  });
  const paused = await completed(
    queue,
    queue.submit({ fileId: file.id, engine: "mistral" }).id,
  );
  expect(paused.status).toBe("needs_attention");
  expect(paused.canResume).toBe(true);
  queue.resume(paused.id);
  expect((await completed(queue, paused.id)).status).toBe("succeeded");
  expect(submissions).toBe(1);
});
