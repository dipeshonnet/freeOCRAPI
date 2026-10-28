import { ProxyAgent } from "undici";
import type { Store } from "./store.js";

export class ResponseLimitError extends Error {}

// Count streamed, decoded bytes rather than trusting the remote length header.
export async function readLimitedBody(response: Response, maxBytes: number) {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new ResponseLimitError("Response exceeds the download limit.");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return Buffer.concat(chunks, size);
      size += chunk.value.byteLength;
      if (size > maxBytes)
        throw new ResponseLimitError("Response exceeds the download limit.");
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

const agents = new Map<string, ProxyAgent>();
export function dispatcher(store: Store, override?: string) {
  const encoded = store.setting<string>("proxy");
  const proxy =
    override || (encoded ? store.decrypt<{ url: string }>(encoded).url : "");
  if (!proxy) return undefined;
  if (!agents.has(proxy)) {
    const url = new URL(proxy);
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error("Proxy must use HTTP or HTTPS");
    agents.set(proxy, new ProxyAgent(proxy));
  }
  return agents.get(proxy);
}
