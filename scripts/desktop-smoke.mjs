import { spawn } from "node:child_process";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
const executable = path.resolve(
  "desktop/dist-electron/win-unpacked/FreeOCRapi.exe",
);
const environment = {
  ...process.env,
  FREEOCRAPI_TEST_DATA: path.resolve("data/desktop-smoke"),
  FREEOCRAPI_SMOKE_TEST: "1",
};
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [], {
  env: environment,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
let errors = "";
let ready = false;
const timer = setTimeout(() => {
  child.kill();
  console.error("Desktop startup timed out. " + errors);
  process.exitCode = 1;
}, 45000);
child.stdout.on("data", (chunk) => {
  output += chunk;
  const match = output.match(
    /FREEOCRAPI_DESKTOP_READY (http:\/\/127\.0\.0\.1:\d+)/,
  );
  if (match && !ready) {
    ready = true;
    void fetch(match[1] + "/health").then((r) => {
      if (!r.ok) throw new Error("Desktop API health failed");
      console.log(
        "Packaged desktop booted, created its tray, signed in locally and started its embedded API.",
      );
    });
  }
});
child.stderr.on("data", (chunk) => (errors += chunk));
child.on("error", (error) => {
  clearTimeout(timer);
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", async (code) => {
  clearTimeout(timer);
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/desktop-smoke.json",
    JSON.stringify(
      { ready, exitCode: code, checkedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
  if (!ready || code) {
    console.error(errors || "Desktop failed to start");
    process.exitCode = 1;
  }
});
