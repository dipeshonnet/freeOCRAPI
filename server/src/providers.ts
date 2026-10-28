import type { OcrOptions, OcrResult } from "../../shared/types.js";
import type { FileRecord } from "./documents.js";
import { recognizeLocal } from "./documents.js";
import type { Store } from "./store.js";
export interface ProviderContext {
  store: Store;
  file: FileRecord;
  options: OcrOptions;
  secret: Record<string, string>;
  signal: AbortSignal;
  operation?: string;
  onOperation: (value: string) => void;
  progress: (page: number) => void;
}
export type Provider = (context: ProviderContext) => Promise<OcrResult>;
export class ProviderError extends Error {
  constructor(
    message: string,
    public safeToFallback = false,
    public retryAfter = 0,
    public invalidCredential = false,
  ) {
    super(message);
  }
}
export const providers = new Map<string, Provider>([
  [
    "tesseract",
    (context) =>
      recognizeLocal(
        context.store,
        context.file,
        context.options,
        context.signal,
        context.progress,
      ),
  ],
]);
