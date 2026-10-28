import { afterEach, expect, test, vi } from "vitest";
import type { Server } from "node:http";
import { createApp } from "./app.js";
import { Store } from "./store.js";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { session } from "./auth.js";
import { saveDocument } from "./documents.js";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import type { JobQueue } from "./jobs.js";
const servers: Server[] = [];
const queues: JobQueue[] = [];
const stores: Store[] = [];

test("CSV downloads neutralize formulas while preserving raw OCR and ordinary CSV cells", async () => {
  const store = new Store(mkdtempSync(path.join(tmpdir(), "freeocrapi-test-")));
  stores.push(store);
  const app = createApp(store);
  const queue: JobQueue = app.locals.queue;
  queues.push(queue);
  await queue.close();
  const file = await saveDocument(
    store,
    "fixture.png",
    createCanvas(10, 10).toBuffer("image/png"),
  );
  const values = [
    '=HYPERLINK("https://example.invalid")',
    "+1+1",
    "-1+1",
    "@SUM(1)",
    " \t=1+1",
    "\r=1",
    "\n=1",
    "\ttext",
    "\ufeff=1",
    "\u0000=1",
    "＝1+1",
    "-100",
    "100",
    "Total",
    'comma,quote"\nnext',
  ];
  const expected = [
    `"'=HYPERLINK(""https://example.invalid"")"`,
    `"'+1+1"`,
    `"'-1+1"`,
    `"'@SUM(1)"`,
    `"' \t=1+1"`,
    `"'\r=1"`,
    `"'\n=1"`,
    `"'\ttext"`,
    `"'\ufeff=1"`,
    `"'\u0000=1"`,
    `"'＝1+1"`,
    `"'-100"`,
    '"100"',
    '"Total"',
    '"comma,quote""\nnext"',
  ].join(",");
  const result = {
    engine: "tesseract",
    provider: "Local",
    text: values[0],
    markdown: values[0],
    usage: { pages: 1, credits: null },
    pages: [
      {
        number: 1,
        text: values[0],
        markdown: values[0],
        blocks: [],
        tables: [{ rows: [values] }],
      },
    ],
  };
  const job = queue.submit({ fileId: file.id });
  store.db
    .prepare("UPDATE jobs SET status='succeeded',result=? WHERE id=?")
    .run(JSON.stringify(result), job.id);
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Authorization: `Bearer ${store.unifiedKey()}` };
  const download = await fetch(
    `${base}/v1/jobs/${job.id}/download?format=csv`,
    { headers },
  );
  expect(download.status).toBe(200);
  expect(download.headers.get("content-disposition")).toContain("attachment");
  expect(await download.text()).toBe(expected);
  const raw = await fetch(`${base}/v1/jobs/${job.id}/download?format=json`, {
    headers,
  });
  expect(await raw.json()).toEqual(result);
});

test("language downloads stop oversized streams and preserve bounded model bytes", async () => {
  const store = new Store(mkdtempSync(path.join(tmpdir(), "freeocrapi-test-")));
  stores.push(store);
  const app = createApp(store);
  queues.push(app.locals.queue);
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Authorization: `Bearer ${session(store)}` };
  let pulls = 0,
    cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(16 * 1024 * 1024));
        if (pulls === 8) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const realFetch = globalThis.fetch;
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(stream));
  try {
    const oversized = await realFetch(`${base}/api/languages/deu`, {
      method: "POST",
      headers,
    });
    expect(oversized.status).toBe(413);
    expect(pulls).toBe(4);
    expect(cancelled).toBe(true);
    const target = path.join(store.dataDir, "languages", "deu.traineddata.gz");
    expect(existsSync(target)).toBe(false);
    const fixture = new Uint8Array([0, 1, 255, 13, 10]);
    fetchMock.mockResolvedValueOnce(new Response(fixture));
    const accepted = await realFetch(`${base}/api/languages/deu`, {
      method: "POST",
      headers,
    });
    expect(accepted.status).toBe(200);
    expect(gunzipSync(readFileSync(target))).toEqual(Buffer.from(fixture));
  } finally {
    fetchMock.mockRestore();
  }
});
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const queue of queues.splice(0)) await queue.close();
  for (const store of stores.splice(0)) {
    store.close();
    if (
      path.dirname(store.dataDir) !== tmpdir() ||
      !path.basename(store.dataDir).startsWith("freeocrapi-test-")
    )
      throw new Error("Unsafe test cleanup path");
    rmSync(store.dataDir, { recursive: true, force: true });
  }
});
test("health endpoint is reachable and avoids disclosure headers", async () => {
  const store = new Store(mkdtempSync(path.join(tmpdir(), "freeocrapi-test-")));
  stores.push(store);
  const app = createApp(store);
  queues.push(app.locals.queue);
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const address = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  expect(response.status).toBe(200);
  expect(response.headers.get("x-powered-by")).toBeNull();
  expect(await response.json()).toMatchObject({
    app: "FreeOCRapi",
    status: "ok",
  });
});
test("accounts protect admin routes and credentials remain encrypted across restart", async () => {
  const store = new Store(mkdtempSync(path.join(tmpdir(), "freeocrapi-test-")));
  stores.push(store);
  const app = createApp(store);
  queues.push(app.locals.queue);
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  expect((await fetch(`${base}/api/keys`)).status).toBe(401);
  const setup = await fetch(`${base}/api/auth/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "test@example.com",
      password: "correct-horse-battery",
    }),
  });
  expect(setup.status).toBe(201);
  const { token } = (await setup.json()) as { token: string };
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  const add = await fetch(`${base}/api/keys`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      engine: "mistral",
      label: "Test",
      secret: { apiKey: "fixture-secret-not-real" },
    }),
  });
  expect(add.status).toBe(201);
  const rows = await (await fetch(`${base}/api/keys`, { headers })).text();
  expect(rows).not.toContain("fixture-secret-not-real");
  const stored = store.db.prepare("SELECT secret FROM credentials").get() as {
    secret: string;
  };
  expect(stored.secret).not.toContain("fixture-secret-not-real");
  expect(store.decrypt(stored.secret).apiKey).toBe("fixture-secret-not-real");
  const second = new Store(store.dataDir);
  expect(second.decrypt(stored.secret).apiKey).toBe("fixture-secret-not-real");
  second.close();
  const apiHeaders = { Authorization: `Bearer ${store.unifiedKey()}` };
  expect(
    (await fetch(`${base}/api/keys`, { headers: apiHeaders })).status,
  ).toBe(401);
  await fetch(`${base}/api/auth/logout`, { method: "POST", headers });
  expect((await fetch(`${base}/api/keys`, { headers })).status).toBe(401);
});
test("unified API uploads, queues, recognizes and downloads a real document", async () => {
  const store = new Store(mkdtempSync(path.join(tmpdir(), "freeocrapi-test-")));
  stores.push(store);
  const app = createApp(store);
  queues.push(app.locals.queue);
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Authorization: `Bearer ${store.unifiedKey()}` };
  const canvas = createCanvas(1000, 180);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 1000, 180);
  ctx.fillStyle = "black";
  ctx.font = "60px Arial";
  ctx.fillText("UPLOAD TEST 2026", 30, 110);
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(canvas.toBuffer("image/png"))], {
      type: "image/png",
    }),
    "upload.png",
  );
  const upload = await fetch(`${base}/v1/files`, {
    method: "POST",
    headers,
    body: form,
  });
  expect(upload.status).toBe(201);
  const file = (await upload.json()) as { id: string };
  const submit = await fetch(`${base}/v1/ocr`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ fileId: file.id }),
  });
  expect(submit.status).toBe(202);
  const job = (await submit.json()) as { id: string };
  const deadline = Date.now() + 15000;
  let status = "queued";
  while (Date.now() < deadline) {
    const data = (await (
      await fetch(`${base}/v1/jobs/${job.id}`, { headers })
    ).json()) as { status: string };
    status = data.status;
    if (!["queued", "running"].includes(status)) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  expect(status).toBe("succeeded");
  const download = await fetch(
    `${base}/v1/jobs/${job.id}/download?format=txt`,
    { headers },
  );
  expect(await download.text()).toContain("2026");
  expect((await fetch(`${base}/v1/jobs/${job.id}`)).status).toBe(401);
}, 30000);
test("public docs and bearer-authenticated MCP expose the actual processing contract", async () => {
  const store = new Store(mkdtempSync(path.join(tmpdir(), "freeocrapi-test-")));
  stores.push(store);
  const app = createApp(store);
  queues.push(app.locals.queue);
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const spec = (await (await fetch(`${base}/v1/openapi.json`)).json()) as {
    paths: Record<string, unknown>;
  };
  expect(spec.paths).toHaveProperty("/v1/ocr");
  expect((await fetch(`${base}/v1/docs`)).status).toBe(200);
  const headers = {
    Authorization: `Bearer ${store.unifiedKey()}`,
    "Content-Type": "application/json",
  };
  const call = await fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const data = (await call.json()) as { result: { tools: { name: string }[] } };
  expect(data.result.tools.map((t) => t.name)).toContain("extract_document");
  expect(
    (
      await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
  ).toBe(401);
  const remote = await fetch(`${base}/v1/ocr`, {
    method: "POST",
    headers,
    body: JSON.stringify({ url: "http://127.0.0.1/private.pdf" }),
  });
  expect(remote.status).toBe(400);
});
