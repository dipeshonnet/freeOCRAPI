const idParameter = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
};
const ocrRequest = {
  type: "object",
  properties: {
    fileId: { type: "string", format: "uuid" },
    url: { type: "string", format: "uri" },
    engine: { type: "string", default: "auto" },
    profile: { type: "string", default: "default" },
    options: {
      type: "object",
      properties: {
        language: { type: "string" },
        pages: { type: "array", items: { type: "integer", minimum: 1 } },
        grayscale: { type: "boolean" },
        threshold: { type: "boolean" },
        rotate: { enum: [0, 90, 180, 270] },
        capabilities: {
          type: "array",
          items: {
            enum: ["text", "pdf", "tables", "forms", "handwriting", "layout"],
          },
        },
      },
    },
  },
  oneOf: [{ required: ["fileId"] }, { required: ["url"] }],
};
const body = (schema: unknown) => ({
  required: true,
  content: { "application/json": { schema } },
});
export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "FreeOCRapi",
    version: "0.1.0",
    description:
      "One engine per document with sequential failover. Page numbers are 1-based.",
  },
  servers: [{ url: "/" }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    schemas: { OcrRequest: ocrRequest },
  },
  paths: {
    "/v1/jobs/{id}/resume": {
      post: {
        summary:
          "Resume polling a saved upstream operation without submitting again",
        parameters: [idParameter],
        responses: {
          200: { description: "Resumed job" },
          409: { description: "No safe saved operation to resume" },
        },
      },
    },
    "/health": {
      get: {
        summary: "Service health",
        security: [],
        responses: { 200: { description: "Healthy" } },
      },
    },
    "/v1/files": {
      post: {
        summary: "Upload document",
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["file"],
                properties: { file: { type: "string", format: "binary" } },
              },
            },
          },
        },
        responses: {
          201: { description: "File metadata including id and page count" },
        },
      },
    },
    "/v1/models": {
      get: {
        summary: "List OCR engines and capabilities",
        responses: { 200: { description: "Engine catalog" } },
      },
    },
    "/v1/ocr": {
      post: {
        summary: "Queue OCR from a file ID or public URL",
        requestBody: body({ $ref: "#/components/schemas/OcrRequest" }),
        responses: {
          202: { description: "Persisted job; poll its Location header" },
          400: { description: "Invalid request" },
          401: { description: "Invalid bearer token" },
        },
      },
    },
    "/v1/jobs": {
      get: {
        summary: "List recent OCR jobs",
        responses: { 200: { description: "Job list" } },
      },
    },
    "/v1/jobs/{id}": {
      get: {
        summary: "Read job, attempts and normalized results",
        parameters: [idParameter],
        responses: {
          200: { description: "Job result" },
          404: { description: "Unknown job" },
        },
      },
    },
    "/v1/jobs/{id}/cancel": {
      post: {
        summary: "Cancel an OCR job",
        parameters: [idParameter],
        responses: {
          200: { description: "Cancelled job" },
          409: { description: "Job is terminal" },
        },
      },
    },
    "/v1/jobs/{id}/download": {
      get: {
        summary: "Download OCR output",
        parameters: [
          idParameter,
          {
            name: "format",
            in: "query",
            schema: { enum: ["txt", "md", "json", "csv"] },
          },
        ],
        responses: {
          200: { description: "Downloaded text, Markdown, JSON or CSV" },
          409: { description: "No completed result" },
        },
      },
    },
    "/v1/batches": {
      post: {
        summary: "Queue an atomic batch of uploaded files",
        requestBody: body({
          type: "object",
          required: ["files"],
          properties: {
            files: {
              type: "array",
              minItems: 1,
              maxItems: 100,
              items: {
                allOf: [
                  { $ref: "#/components/schemas/OcrRequest" },
                  { required: ["fileId"] },
                ],
              },
            },
          },
        }),
        responses: { 202: { description: "Batch ID and jobs" } },
      },
    },
  },
};
