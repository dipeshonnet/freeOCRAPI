import { Router } from "express";
import { z } from "zod";
import type { Store } from "./store.js";
import type { JobQueue } from "./jobs.js";
import { engineRows } from "./admin.js";
import { fetchDocument } from "./remote-documents.js";

import { openapi } from "./openapi.js";
const docsHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FreeOCRapi API reference</title><style>body{font:14px system-ui;max-width:1000px;margin:40px auto;padding:0 22px;color:#222}h1{letter-spacing:-1px}section{border:1px solid #ddd;border-radius:18px;padding:22px;margin:22px 0}input,textarea,select,button{font:inherit;padding:10px;border:1px solid #ddd;border-radius:8px}input[type=password],textarea{display:block;width:94%;margin:12px 0}button{cursor:pointer;background:#171717;color:white}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f6f6f6;border-radius:12px;padding:18px;max-height:500px;overflow:auto}p{color:#666;line-height:1.6}code{font-size:12px}.row{display:flex;gap:10px;flex-wrap:wrap}</style></head><body><a href="/">← Dashboard</a><h1>FreeOCRapi API reference</h1><p>Upload → submit → poll → download. Every request uses your unified bearer key. One engine handles each document.</p><section><label>Unified API key<input id="key" type="password" autocomplete="off" placeholder="freeocrapi-…"></label><p>Your key is used only in this page's requests and is not saved.</p></section><section><h2>Try OCR</h2><input id="file" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.tif,.tiff"><button id="process">Upload and extract</button><pre id="result">Choose a document to begin.</pre></section><section><h2>Endpoints</h2><div id="endpoints"></div><p><a href="/v1/openapi.json">Download OpenAPI specification</a></p><div class="row"><button id="models">List engines</button><button id="jobs">List jobs</button></div></section><script src="/v1/docs/app.js"></script></body></html>`;
const docsJs = `const output=document.getElementById('result');const key=document.getElementById('key');async function request(url,options={}){const headers=new Headers(options.headers);headers.set('Authorization','Bearer '+key.value);if(options.body&&!(options.body instanceof FormData))headers.set('Content-Type','application/json');const response=await fetch(url,{...options,headers});const data=await response.json();if(!response.ok)throw new Error(data.error?.message||response.status);output.textContent=JSON.stringify(data,null,2);return data;}document.getElementById('models').onclick=()=>request('/v1/models').catch(e=>output.textContent=e.message);document.getElementById('jobs').onclick=()=>request('/v1/jobs').catch(e=>output.textContent=e.message);document.getElementById('process').onclick=async(event)=>{const button=event.target;button.disabled=true;try{const file=document.getElementById('file').files[0];if(!file)throw new Error('Choose a document.');const form=new FormData();form.append('file',file);const upload=await request('/v1/files',{method:'POST',body:form});let job=await request('/v1/ocr',{method:'POST',body:JSON.stringify({fileId:upload.id})});while(['queued','running'].includes(job.status)){await new Promise(resolve=>setTimeout(resolve,1000));job=await request('/v1/jobs/'+job.id);}}catch(e){output.textContent=e.message;}finally{button.disabled=false;}};fetch('/v1/openapi.json').then(r=>r.json()).then(spec=>{const list=document.getElementById('endpoints');for(const [path,methods]of Object.entries(spec.paths))for(const [method,operation]of Object.entries(methods)){const p=document.createElement('p');const code=document.createElement('code');code.textContent=method.toUpperCase()+' '+path;p.append(code,document.createTextNode(' — '+operation.summary));list.append(p);}});`;
export function docsRoutes() {
  const router = Router();
  router.get("/docs", (_req, res) => res.type("html").send(docsHtml));
  router.get("/docs/app.js", (_req, res) =>
    res.type("application/javascript").send(docsJs),
  );
  router.get("/openapi.json", (_req, res) => res.json(openapi));
  return router;
}

const tools = [
  {
    name: "list_engines",
    description: "List OCR engines, capabilities and availability.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "extract_document",
    description:
      "Submit OCR for an uploaded file ID or public document URL. Poll get_job until completion.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string" },
        url: { type: "string" },
        engine: { type: "string", default: "auto" },
        profile: { type: "string", default: "default" },
      },
      oneOf: [{ required: ["fileId"] }, { required: ["url"] }],
    },
  },
  {
    name: "get_job",
    description: "Read a job and its extracted pages.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "cancel_job",
    description: "Cancel an active or queued OCR job.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "get_usage",
    description: "Read this month’s settled page and request usage.",
    inputSchema: { type: "object", properties: {} },
  },
];
export function mcpRoutes(store: Store, queue: JobQueue) {
  const router = Router();
  router.post("/", async (req, res) => {
    const rpc = z
      .object({
        jsonrpc: z.literal("2.0"),
        id: z.union([z.string(), z.number(), z.null()]).optional(),
        method: z.string(),
        params: z.record(z.unknown()).optional(),
      })
      .parse(req.body);
    if (rpc.id === undefined) {
      res.sendStatus(202);
      return;
    }
    let result: unknown;
    if (rpc.method === "initialize")
      result = {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "FreeOCRapi", version: "0.1.0" },
      };
    else if (rpc.method === "ping") result = {};
    else if (rpc.method === "tools/list") result = { tools };
    else if (rpc.method === "tools/call") {
      try {
        const name = String(rpc.params?.name);
        const args = z.record(z.unknown()).parse(rpc.params?.arguments || {});
        let value: unknown;
        if (name === "list_engines") value = engineRows(store);
        else if (name === "get_usage")
          value = store.db
            .prepare(
              "SELECT engine,SUM(requests) AS requests,SUM(pages) AS pages FROM monthly_usage WHERE month=? GROUP BY engine",
            )
            .all(new Date().toISOString().slice(0, 7));
        else if (name === "get_job")
          value = queue.get(z.string().uuid().parse(args.id));
        else if (name === "cancel_job")
          value = queue.cancel(z.string().uuid().parse(args.id));
        else if (name === "extract_document") {
          if (args.url) {
            const file = await fetchDocument(
              store,
              z.string().url().parse(args.url),
            );
            args.fileId = file.id;
          }
          value = queue.submit(args);
        } else throw new Error("Unknown tool.");
        result = { content: [{ type: "text", text: JSON.stringify(value) }] };
      } catch (e) {
        result = {
          isError: true,
          content: [
            {
              type: "text",
              text: e instanceof Error ? e.message : "Tool failed.",
            },
          ],
        };
      }
    } else {
      res.json({
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32601, message: "Method not found" },
      });
      return;
    }
    res.json({ jsonrpc: "2.0", id: rpc.id, result });
  });
  router.get("/", (_req, res) =>
    res
      .status(405)
      .set("Allow", "POST")
      .json({ error: "Use stateless JSON-RPC POST for MCP." }),
  );
  return router;
}
