export type Capability =
  "text" | "pdf" | "tables" | "forms" | "handwriting" | "layout";
export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "needs_attention";
export type Strategy =
  "manual" | "balanced" | "quality" | "fastest" | "reliable" | "custom";
export interface Engine {
  id: string;
  name: string;
  provider: string;
  description: string;
  local: boolean;
  capabilities: Capability[];
  formats: string[];
  enabled: boolean;
  configured: boolean;
  status: string;
  pagesUsed: number;
  pageLimit: number | null;
  requests: number;
  reliability: number | null;
  latencyMs: number | null;
}
export interface OcrOptions {
  language?: string;
  pages?: number[];
  rotate?: number;
  grayscale?: boolean;
  threshold?: boolean;
  capabilities?: Capability[];
}
export interface OcrBlock {
  text: string;
  bbox?: [number, number, number, number];
  confidence?: number | null;
}
export interface OcrTable {
  rows: string[][];
  bbox?: [number, number, number, number];
}
export interface OcrPage {
  number: number;
  text: string;
  markdown: string;
  width?: number;
  height?: number;
  blocks: OcrBlock[];
  tables: OcrTable[];
  fields?: Record<string, unknown>;
  confidence?: number | null;
}
export interface OcrResult {
  engine: string;
  provider: string;
  pages: OcrPage[];
  text: string;
  markdown: string;
  usage: { pages: number; credits: number | null };
  raw?: unknown;
  cached?: boolean;
}
export interface OcrJob {
  id: string;
  fileId: string;
  filename: string;
  engine: string;
  status: JobStatus;
  options: OcrOptions;
  createdAt: string;
  updatedAt: string;
  error: string | null;
  result?: OcrResult | null;
  batchId?: string | null;
}
export interface Profile {
  id: string;
  name: string;
  engines: string[];
  strategy: Strategy;
}
export interface ProviderCredential {
  id: string;
  engine: string;
  label: string;
  enabled: boolean;
  status: string;
  checkedAt: string | null;
  requestCap: number;
  pageCap: number;
}
