#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    key: { type: "string" },
    token: { type: "string" },
    engine: { type: "string" },
    language: { type: "string" },
    out: { type: "string" },
    wait: { type: "boolean" },
    "secret-file": { type: "string" },
    label: { type: "string" },
    "dry-run": { type: "boolean" },
    output: { type: "string" },
    help: { type: "boolean" },
  },
});
const base = (
  values.url ||
  process.env.FREEOCRAPI_URL ||
  "http://127.0.0.1:3002"
).replace(/\/$/, "");
const key = values.key || process.env.FREEOCRAPI_API_KEY || "";
const session = values.token || process.env.FREEOCRAPI_DASHBOARD_TOKEN || "";
async function request(route, options = {}, admin = false) {
  const headers = new Headers(options.headers);
  if (admin ? session : key)
    headers.set("Authorization", `Bearer ${admin ? session : key}`);
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  const response = await fetch(base + route, {
    ...options,
    headers,
    // Never replay documents or provider credentials at a redirected endpoint.
    redirect: "manual",
    signal: AbortSignal.timeout(60000),
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Error(
      "Gateway redirects are disabled. Configure the final gateway URL.",
    );
  }
  if (!response.ok) {
    let error;
    try {
      error = await response.json();
    } catch {}
    throw new Error(error?.error?.message || `HTTP ${response.status}`);
  }
  return response.json();
}
async function wait(id) {
  while (true) {
    const job = await request(`/v1/jobs/${encodeURIComponent(id)}`);
    if (!["running", "queued"].includes(job.status)) {
      if (job.status !== "succeeded")
        throw new Error(
          `${job.status}: ${job.error || "No result"}. Resume job ID: ${id}`,
        );
      return job;
    }
    await delay(1000);
  }
}
async function main() {
  const [command, arg, ...rest] = positionals;
  if (values.help || !command) {
    console.log(
      "FreeOCRapi CLI\n\nocr FILE [--engine ID] [--language eng] [--out FILE]\nbatch FILE...\njobs [JOB_ID] [--wait]\ncancel JOB_ID\nengines\ndoctor\nkeys list|add ENGINE|remove ID|check [ID] --token SESSION [--secret-file JSON]\nsetup-llamaindex|setup-langchain|setup-haystack --output DIR [--dry-run]\n\nUse FREEOCRAPI_URL and FREEOCRAPI_API_KEY; admin commands use FREEOCRAPI_DASHBOARD_TOKEN. No token is persisted.",
    );
    return;
  }
  if (command === "doctor") {
    const health = await request("/health");
    console.log(
      JSON.stringify(
        {
          url: base,
          health,
          node: process.version,
          processingKeyConfigured: Boolean(key),
          dashboardSessionConfigured: Boolean(session),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "engines") {
    console.log(JSON.stringify(await request("/v1/models"), null, 2));
    return;
  }
  if (command === "jobs") {
    console.log(
      JSON.stringify(
        arg
          ? values.wait
            ? await wait(arg)
            : await request(`/v1/jobs/${encodeURIComponent(arg)}`)
          : await request("/v1/jobs"),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "cancel") {
    if (!arg) throw new Error("Supply a job ID.");
    console.log(
      JSON.stringify(
        await request(`/v1/jobs/${encodeURIComponent(arg)}/cancel`, {
          method: "POST",
          body: "{}",
        }),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "ocr" || command === "batch") {
    const files = [arg, ...rest].filter(Boolean);
    if (!files.length) throw new Error("Supply a document path.");
    const inputs = [];
    for (const filename of files) {
      const data = await readFile(filename);
      const form = new FormData();
      form.append("file", new Blob([data]), path.basename(filename));
      const file = await request("/v1/files", { method: "POST", body: form });
      inputs.push({
        fileId: file.id,
        engine: values.engine || "auto",
        options: values.language ? { language: values.language } : {},
      });
    }
    let jobs;
    if (command === "batch") {
      jobs = (
        await request("/v1/batches", {
          method: "POST",
          body: JSON.stringify({ files: inputs }),
        })
      ).jobs;
    } else {
      jobs = [
        await request("/v1/ocr", {
          method: "POST",
          body: JSON.stringify(inputs[0]),
        }),
      ];
    }
    await mkdir("data/cli", { recursive: true });
    await writeFile(
      "data/cli/last-jobs.json",
      JSON.stringify(
        {
          url: base,
          jobs: jobs.map((j) => j.id),
          savedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    console.error(
      `Saved job IDs: ${jobs.map((j) => j.id).join(", ")} (data/cli/last-jobs.json)`,
    );
    const results = [];
    for (const job of jobs) results.push(await wait(job.id));
    const text =
      command === "ocr"
        ? results[0].result.text
        : JSON.stringify(results, null, 2);
    if (values.out) await writeFile(values.out, text);
    else console.log(text);
    return;
  }
  if (command === "keys") {
    if (!session)
      throw new Error(
        "Set FREEOCRAPI_DASHBOARD_TOKEN for credential management.",
      );
    if (arg === "list")
      console.log(
        JSON.stringify(await request("/api/keys", {}, true), null, 2),
      );
    else if (arg === "check")
      console.log(
        JSON.stringify(
          await request(
            rest[0]
              ? `/api/keys/${encodeURIComponent(rest[0])}/check`
              : "/api/keys/check",
            { method: "POST", body: "{}" },
            true,
          ),
          null,
          2,
        ),
      );
    else if (arg === "remove") {
      if (!rest[0]) throw new Error("Supply a credential ID.");
      await request(
        `/api/keys/${encodeURIComponent(rest[0])}`,
        { method: "DELETE" },
        true,
      );
      console.log("Credential removed.");
    } else if (arg === "add") {
      if (!rest[0] || !values["secret-file"])
        throw new Error(
          "Use keys add ENGINE --secret-file credentials.json [--label NAME].",
        );
      const secret = JSON.parse(await readFile(values["secret-file"], "utf8"));
      const result = await request(
        "/api/keys",
        {
          method: "POST",
          body: JSON.stringify({
            engine: rest[0],
            label: values.label || rest[0],
            secret,
          }),
        },
        true,
      );
      console.log(`Credential saved: ${result.id}`);
    } else throw new Error("Use keys list, add, remove or check.");
    return;
  }
  if (command.startsWith("setup-")) {
    const framework = command.slice(6);
    if (!["llamaindex", "langchain", "haystack"].includes(framework))
      throw new Error("Unknown framework.");
    if (!values.output)
      throw new Error(
        "Specify --output DIR for generated integration example.",
      );
    const destination = path.resolve(
      values.output,
      `freeocrapi_${framework}_example.py`,
    );
    const configuredUrl = JSON.stringify(base);
    const source = `# Run from the FreeOCRapi project root, or add it to PYTHONPATH.\nfrom integrations.python.freeocrapi import FreeOCRReader, FreeOCRLoader, FreeOCRConverter\n# Set FREEOCRAPI_API_KEY in your environment; credentials are not written here.\n${framework === "llamaindex" ? `documents = FreeOCRReader(base_url=${configuredUrl}).load_data("document.pdf")` : framework === "langchain" ? `documents = FreeOCRLoader("document.pdf", base_url=${configuredUrl}).load()` : `documents = FreeOCRConverter(base_url=${configuredUrl}).run(sources=["document.pdf"])`}\nprint(documents)\n`;
    if (values["dry-run"]) {
      console.log(`Would write ${destination}\n${source}`);
      return;
    }
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      const existing = await readFile(destination);
      await writeFile(`${destination}.${Date.now()}.bak`, existing, {
        flag: "wx",
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await writeFile(destination, source);
    console.log(`Wrote ${destination}`);
    return;
  }
  throw new Error("Unknown command. Use --help.");
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
