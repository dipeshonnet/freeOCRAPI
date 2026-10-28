import { mkdir, copyFile, chmod, writeFile } from "node:fs/promises";
import path from "node:path";
const directory = path.resolve("desktop/runtime");
await mkdir(directory, { recursive: true });
const target = path.join(
  directory,
  process.platform === "win32" ? "node.exe" : "node",
);
await copyFile(process.execPath, target);
if (process.platform !== "win32") await chmod(target, 0o755);
const license = await fetch(
  `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`,
);
if (!license.ok)
  throw new Error(
    "Cannot retrieve the Node runtime license; packaging stopped.",
  );
await writeFile(path.join(directory, "NODE-LICENSE.txt"), await license.text());
console.log(
  `Prepared Node ${process.version} desktop runtime for ${process.platform}/${process.arch}.`,
);
