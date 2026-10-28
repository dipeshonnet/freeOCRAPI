import { readFileSync } from "node:fs";
console.log(readFileSync(new URL("../PROGRESS.md", import.meta.url), "utf8"));
