import { afterEach, expect, test } from "vitest";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const servers = [];
const directories = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise((resolve) => server.close(resolve));
  for (const directory of directories.splice(0)) {
    if (
      path.dirname(directory) !== tmpdir() ||
      !path.basename(directory).startsWith("freeocrapi-cli-")
    )
      throw new Error("Unsafe cleanup path");
    rmSync(directory, { recursive: true, force: true });
  }
});
async function serve(handler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function addKey(base) {
  const directory = mkdtempSync(path.join(tmpdir(), "freeocrapi-cli-"));
  directories.push(directory);
  const filename = path.join(directory, "fixture.json");
  writeFileSync(
    filename,
    JSON.stringify({ apiKey: "fixture-provider-secret" }),
  );
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "cli/index.mjs",
        "keys",
        "add",
        "mistral",
        "--secret-file",
        filename,
        "--url",
        base,
        "--token",
        "fixture-dashboard-token",
      ],
      {
        windowsHide: true,
        env: { ...process.env, FREEOCRAPI_API_KEY: "fixture-processing-key" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test.each([301, 302, 303, 307, 308])(
  "CLI rejects HTTP %s without replaying credential requests",
  async (status) => {
    let received = 0;
    const destination = await serve((req, res) => {
      received++;
      req.resume();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id: "redirected" }));
    });
    const gateway = await serve((req, res) => {
      req.resume();
      res.writeHead(status, { Location: destination + "/received" }).end();
    });
    const result = await addKey(gateway);
    expect(result.code).toBe(1);
    expect(received).toBe(0);
    expect(result.stderr).toContain("Configure the final gateway URL");
    expect(result.stderr).not.toContain("fixture-provider-secret");
  },
);

test("CLI keeps direct authenticated credential submissions working", async () => {
  let authorization,
    body = "";
  const gateway = await serve((req, res) => {
    authorization = req.headers.authorization;
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id: "saved-fixture" }));
    });
  });
  const result = await addKey(gateway);
  expect(result.code).toBe(0);
  expect(authorization).toBe("Bearer fixture-dashboard-token");
  expect(JSON.parse(body).secret.apiKey).toBe("fixture-provider-secret");
  expect(result.stdout).toContain("Credential saved: saved-fixture");
});
