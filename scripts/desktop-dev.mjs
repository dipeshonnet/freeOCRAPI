import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const electron = require("electron");
const environment = { ...process.env, FREEOCRAPI_NODE_PATH: process.execPath };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ["desktop/main.cjs"], {
  stdio: "inherit",
  env: environment,
  windowsHide: true,
});
child.on("exit", (code) => {
  process.exitCode = code || 0;
});
