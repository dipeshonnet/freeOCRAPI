import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent, fetch } from "undici";
import path from "node:path";
import { Store } from "./store.js";
import { AppError } from "./errors.js";
import { saveDocument } from "./documents.js";
const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["192.0.0.0", 24],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const)
  blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 96],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const)
  blocked.addSubnet(network, prefix, "ipv6");
export function publicAddress(address: string) {
  const family = isIP(address);
  if (!family) return false;
  if (family === 6 && address.toLowerCase().startsWith("::ffff:")) return false;
  return !blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}
export async function fetchDocument(store: Store, input: string) {
  let url = new URL(input);
  const max =
    store.setting<{ maxFileMB: number }>("preferences")!.maxFileMB *
    1024 *
    1024;
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new AppError(
        400,
        "Use a public HTTP(S) document URL without embedded credentials.",
      );
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    let addresses;
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new AppError(400, "The document hostname could not be resolved.");
    }
    if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
      throw new AppError(
        400,
        "Document URLs cannot access local or private networks. Upload local files directly.",
      );
    const selected = addresses[0];
    const agent = new Agent({
      connect: {
        lookup: ((
          _host: string,
          options: { all?: boolean },
          callback: (...args: unknown[]) => void,
        ) => {
          if (options.all) callback(null, [selected]);
          else callback(null, selected.address, selected.family);
        }) as never,
      },
    });
    try {
      const result = await fetch(url.toString(), {
        dispatcher: agent,
        redirect: "manual",
        signal: AbortSignal.timeout(60000),
      });
      if ([301, 302, 303, 307, 308].includes(result.status)) {
        const next = result.headers.get("location");
        await result.body?.cancel();
        if (!next)
          throw new AppError(400, "Document redirect has no destination.");
        url = new URL(next, url);
        continue;
      }
      if (!result.ok) {
        await result.body?.cancel();
        throw new AppError(
          400,
          `Document server returned HTTP ${result.status}.`,
        );
      }
      if (Number(result.headers.get("content-length")) > max) {
        await result.body?.cancel();
        throw new AppError(413, "Remote document exceeds the upload limit.");
      }
      if (!result.body) throw new AppError(400, "Remote document has no body.");
      const reader = result.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > max) {
          await reader.cancel();
          throw new AppError(413, "Remote document exceeds the upload limit.");
        }
        chunks.push(chunk.value);
      }
      return await saveDocument(
        store,
        path.basename(decodeURIComponent(url.pathname)) || "remote-document",
        Buffer.concat(chunks),
      );
    } finally {
      await agent.close();
    }
  }
  throw new AppError(400, "Too many document redirects.");
}
