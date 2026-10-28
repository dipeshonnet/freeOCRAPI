import type { Capability } from "../../shared/types.js";
export interface EngineDefinition {
  id: string;
  name: string;
  provider: string;
  description: string;
  local: boolean;
  capabilities: Capability[];
  formats: string[];
  credentialFields: string[];
  docs: string;
}
const images = ["png", "jpeg", "webp", "tiff"];
const documents = ["pdf", ...images];
export const catalog: EngineDefinition[] = [
  {
    id: "tesseract",
    name: "Tesseract",
    provider: "Local",
    description: "Private, on-device text recognition. No API key required.",
    local: true,
    capabilities: ["text", "pdf", "layout"],
    formats: documents,
    credentialFields: [],
    docs: "https://github.com/naptha/tesseract.js",
  },
  {
    id: "llamaparse",
    name: "LlamaParse",
    provider: "LlamaIndex",
    description:
      "Document parsing with text, Markdown, tables and page structure.",
    local: false,
    capabilities: ["text", "pdf", "tables", "layout", "handwriting"],
    formats: documents,
    credentialFields: ["apiKey"],
    docs: "https://developers.llamaindex.ai/llamaparse/",
  },
  {
    id: "mistral",
    name: "Mistral OCR",
    provider: "Mistral",
    description:
      "Document OCR with layout-aware Markdown and structured annotations.",
    local: false,
    capabilities: ["text", "pdf", "tables", "forms", "layout", "handwriting"],
    formats: documents,
    credentialFields: ["apiKey"],
    docs: "https://docs.mistral.ai/api/endpoint/ocr",
  },
  {
    id: "ocrspace",
    name: "OCR.space",
    provider: "OCR.space",
    description:
      "Image and PDF text recognition with configurable plan limits.",
    local: false,
    capabilities: ["text", "pdf", "layout"],
    formats: ["pdf", "png", "jpeg"],
    credentialFields: ["apiKey"],
    docs: "https://ocr.space/ocrapi",
  },
  {
    id: "azure",
    name: "Document Intelligence",
    provider: "Microsoft Azure",
    description: "Read, layout, forms and prebuilt invoice analysis.",
    local: false,
    capabilities: ["text", "pdf", "tables", "forms", "handwriting", "layout"],
    formats: documents,
    credentialFields: ["endpoint", "apiKey"],
    docs: "https://learn.microsoft.com/azure/ai-services/document-intelligence/",
  },
  {
    id: "google",
    name: "Document AI",
    provider: "Google Cloud",
    description:
      "OCR and structured document extraction through configured processors.",
    local: false,
    capabilities: ["text", "pdf", "tables", "forms", "handwriting", "layout"],
    formats: documents,
    credentialFields: [
      "projectId",
      "location",
      "processorId",
      "serviceAccount",
    ],
    docs: "https://cloud.google.com/document-ai/docs",
  },
  {
    id: "textract",
    name: "Amazon Textract",
    provider: "AWS",
    description: "Text, tables, forms and multipage document analysis.",
    local: false,
    capabilities: ["text", "pdf", "tables", "forms", "handwriting", "layout"],
    formats: ["pdf", "png", "jpeg", "tiff"],
    credentialFields: ["region", "accessKeyId", "secretAccessKey", "bucket"],
    docs: "https://docs.aws.amazon.com/textract/",
  },
  {
    id: "paddleocr",
    name: "PaddleOCR",
    provider: "Local service",
    description: "Connect an optional locally hosted PaddleOCR service.",
    local: true,
    capabilities: ["text", "pdf", "layout"],
    formats: documents,
    credentialFields: ["endpoint"],
    docs: "https://github.com/PaddlePaddle/PaddleOCR",
  },
  {
    id: "docling",
    name: "Docling",
    provider: "Local service",
    description: "Connect a local Docling Serve document conversion service.",
    local: true,
    capabilities: ["text", "pdf", "tables", "layout"],
    formats: documents,
    credentialFields: ["endpoint"],
    docs: "https://github.com/docling-project/docling-serve",
  },
  {
    id: "custom",
    name: "Custom OCR endpoint",
    provider: "Custom",
    description:
      "Connect any service implementing the FreeOCRapi adapter contract.",
    local: false,
    capabilities: ["text", "pdf"],
    formats: documents,
    credentialFields: ["endpoint"],
    docs: "/v1/docs",
  },
];
