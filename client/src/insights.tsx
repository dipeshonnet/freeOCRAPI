import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
} from "recharts";
import { Search, ExternalLink, Copy, Download, Upload } from "lucide-react";
import { api, download, notify } from "./api";
import { Header, Empty, Busy, show, date, Badge } from "./ui";
import { useEngines } from "./models";
interface AnalyticsData {
  summary: {
    documents: number;
    successes: number;
    failures: number;
    pages: number;
    attempts: number;
    latency: number | null;
  };
  timeline: {
    date: string;
    requests: number;
    success: number;
    failures: number;
  }[];
  byEngine: {
    engine: string;
    attempts: number;
    pages: number;
    successes: number;
    latency: number | null;
  }[];
}
export function Analytics() {
  const [range, setRange] = useState("7d");
  const { data, isLoading } = useQuery({
    queryKey: ["analytics", range],
    queryFn: () => api<AnalyticsData>(`/api/analytics?range=${range}`),
    refetchInterval: 10000,
  });
  const summary = data?.summary;
  const rate =
    summary && summary.documents
      ? (100 * (summary.successes || 0)) / summary.documents
      : null;
  return (
    <>
      <Header
        title="Analytics"
        description="Document volume, latency, page usage and failures."
        actions={
          <div className="tabs">
            {["24h", "7d", "30d", "90d"].map((r) => (
              <button
                key={r}
                className={range === r ? "selected" : ""}
                onClick={() => setRange(r)}
              >
                {r}
              </button>
            ))}
          </div>
        }
      />
      {isLoading ? (
        <Busy />
      ) : (
        <>
          <div className="metric-grid">
            {[
              ["DOCUMENTS", show(summary?.documents)],
              ["SUCCESS RATE", show(rate, "%")],
              ["PAGES PROCESSED", show(summary?.pages)],
              ["UPSTREAM ATTEMPTS", show(summary?.attempts)],
              ["AVG LATENCY", show(summary?.latency, " ms")],
              ["FAILURES", show(summary?.failures)],
            ].map(([label, value]) => (
              <section className="card metric" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </section>
            ))}
          </div>
          <section className="card chart">
            <h2>Requests over time</h2>
            {data?.timeline.length ? (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={data.timeline}>
                  <CartesianGrid strokeDasharray="3 5" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip />
                  <Line
                    type="monotone"
                    dataKey="success"
                    stroke="var(--fg)"
                    strokeWidth={1.6}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="failures"
                    stroke="#d73b49"
                    strokeWidth={1.6}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <Empty title="No requests in this period">
                Process a document to start measuring activity.
              </Empty>
            )}
          </section>
          <section className="card chart">
            <h2>Pages by engine</h2>
            {data?.byEngine.length ? (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={data.byEngine}>
                  <XAxis dataKey="engine" tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="pages" fill="var(--fg)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <Empty title="No engine usage yet" />
            )}
          </section>
        </>
      )}
    </>
  );
}
interface LogRow {
  id: string;
  filename: string;
  engine: string;
  status: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
export function Logs() {
  const [q, setQ] = useState("");
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["logs", q],
    queryFn: () => api<LogRow[]>(`/api/logs?q=${encodeURIComponent(q)}`),
    refetchInterval: 5000,
  });
  return (
    <>
      <Header
        title="Request logs"
        description="Inspect processing status, routing outcomes and errors."
      />
      <div className="search">
        <Search size={15} />
        <input
          aria-label="Search logs"
          placeholder="Search documents, job IDs or errors…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {isLoading ? (
        <Busy />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Document</th>
                <th>Engine</th>
                <th>Status</th>
                <th>Time</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link to={`/jobs/${row.id}`}>{row.filename}</Link>
                  </td>
                  <td>{row.engine}</td>
                  <td>
                    <span className={`status ${row.status}`}>
                      {row.status.replaceAll("_", " ")}
                    </span>
                  </td>
                  <td>{date(row.createdAt)}</td>
                  <td className="error-text">{row.error || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <Empty title="No matching requests" />}
        </div>
      )}
    </>
  );
}
interface DocumentRow {
  id: string;
  filename: string;
  engine: string;
  createdAt: string;
  excerpt: string;
}
export function SearchDocuments() {
  const [q, setQ] = useState("");
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["documents", q],
    queryFn: () =>
      api<DocumentRow[]>(`/api/documents?q=${encodeURIComponent(q)}`),
  });
  return (
    <>
      <Header
        title="Document search"
        description="Find text in completed OCR results stored on this installation."
      />
      <div className="search">
        <Search size={16} />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search extracted text or document names…"
          aria-label="Search extracted text"
        />
      </div>
      {isLoading ? (
        <Busy />
      ) : rows.length ? (
        rows.map((row) => (
          <Link
            className="card document-hit"
            key={row.id}
            to={`/jobs/${row.id}`}
          >
            <h2>{row.filename}</h2>
            <p>{row.excerpt || "Blank extracted page"}</p>
            <span className="small muted">
              {row.engine} · {date(row.createdAt)}
            </span>
          </Link>
        ))
      ) : (
        <Empty title="No matching documents">
          Completed OCR text becomes searchable here.
        </Empty>
      )}
    </>
  );
}
const integrations = [
  {
    name: "LlamaIndex",
    kind: "Python reader",
    description:
      "Load OCR results as LlamaIndex Documents with source and page metadata.",
    code: 'from integrations.python.freeocrapi import FreeOCRReader\nreader = FreeOCRReader(base_url="http://127.0.0.1:3002", api_key="<unified-key>")\ndocuments = reader.load_data("document.pdf")',
  },
  {
    name: "LangChain",
    kind: "Python loader",
    description: "Use parsed pages in LangChain document workflows.",
    code: 'from integrations.python.freeocrapi import FreeOCRLoader\ndocuments = FreeOCRLoader("document.pdf", base_url="http://127.0.0.1:3002", api_key="<unified-key>").load()',
  },
  {
    name: "Haystack",
    kind: "Python component",
    description: "Convert local documents into Haystack Documents.",
    code: 'from integrations.python.freeocrapi import FreeOCRConverter\nresult = FreeOCRConverter(base_url="http://127.0.0.1:3002", api_key="<unified-key>").run(sources=["document.pdf"])',
  },
  {
    name: "REST API",
    kind: "HTTP",
    description:
      "Upload, submit, poll and download through one bearer-authenticated API.",
    code: 'POST /v1/files  (multipart file)\nPOST /v1/ocr    {"fileId":"<file-id>","engine":"auto"}\nGET /v1/jobs/<job-id>',
  },
  {
    name: "MCP",
    kind: "Agent tools",
    description:
      "Let MCP clients submit OCR jobs and inspect engines and results.",
    code: "Endpoint: http://127.0.0.1:3002/mcp\nAuthorization: Bearer <unified-key>\nTools: list_engines, extract_document, get_job",
  },
  {
    name: "Command line",
    kind: "Local CLI",
    description: "Process documents and manage credentials from your terminal.",
    code: "node cli/index.mjs ocr document.pdf --url http://127.0.0.1:3002\nnode cli/index.mjs jobs --url http://127.0.0.1:3002\nnode cli/index.mjs doctor --url http://127.0.0.1:3002",
  },
];
export function Agents() {
  const gateway = import.meta.env.DEV
    ? `${location.protocol}//${location.hostname}:${__SERVER_PORT__}`
    : location.origin;
  const example = (code: string) =>
    code.replaceAll("http://127.0.0.1:3002", gateway);
  return (
    <>
      <Header
        title="Agents & integrations"
        description="Connect your document workflows to one OCR gateway."
      />
      <section className="card">
        <h2>One endpoint, your existing tools</h2>
        <p>
          Your frameworks receive normalized OCR output. The gateway handles
          engine selection, credentials and sequential fallback.
        </p>
        <code>FREEOCRAPI_URL={gateway}</code>
        <p className="small">
          Use your unified key from the Keys screen. Run these examples from the
          FreeOCRapi project root.
        </p>
      </section>
      <div className="integration-grid">
        {integrations.map((item) => (
          <section className="card integration" key={item.name}>
            <Badge>{item.kind}</Badge>
            <h2>{item.name}</h2>
            <p>{item.description}</p>
            <pre>{example(item.code)}</pre>
            <button
              onClick={() =>
                void navigator.clipboard
                  .writeText(example(item.code))
                  .then(() => notify("Example copied."))
                  .catch(() => notify("Clipboard unavailable."))
              }
            >
              <Copy size={14} />
              Copy example
            </button>
          </section>
        ))}
      </div>
    </>
  );
}
export function Catalog() {
  const { data: engines = [] } = useEngines();
  return (
    <>
      <Header
        title="Catalog & updates"
        description="Your OCR providers, capabilities and installation updates."
        actions={
          <>
            <button
              onClick={() =>
                void download(
                  "/api/catalog/export",
                  "freeocrapi-catalog.json",
                ).catch((e) => notify(e.message))
              }
            >
              <Download size={14} />
              Export catalog
            </button>
            <label className="button">
              <Upload size={14} />
              Import configuration
              <input
                type="file"
                accept="application/json"
                hidden
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  try {
                    const value = JSON.parse(await file.text());
                    await api("/api/catalog/import", {
                      method: "POST",
                      body: JSON.stringify(value),
                    });
                    notify("Catalog configuration imported.");
                    location.reload();
                  } catch (error) {
                    notify((error as Error).message);
                  }
                  e.target.value = "";
                }}
              />
            </label>
          </>
        }
      />
      <section className="card">
        <h2>FreeOCRapi</h2>
        <p>Version 0.1.0 · Local-first OCR gateway</p>
        <div className="actions">
          <Badge>Bundled catalog</Badge>
          <Badge>{engines.length} engines</Badge>
          <Badge>{engines.filter((e) => e.configured).length} configured</Badge>
        </div>
        <p className="small">
          No release channel has been configured. This installation does not
          contact the FreeLLMAPI catalog or update service.
        </p>
      </section>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Engine</th>
              <th>Execution</th>
              <th>Capabilities</th>
              <th>Documentation</th>
            </tr>
          </thead>
          <tbody>
            {engines.map((e) => (
              <tr key={e.id}>
                <td>{e.name}</td>
                <td>{e.local ? "Local / self-hosted" : "Cloud"}</td>
                <td>{e.capabilities.join(", ")}</td>
                <td>
                  <a href={e.docs} target="_blank" rel="noreferrer">
                    View docs <ExternalLink size={12} />
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
