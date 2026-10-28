import { useEffect, useState, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  Upload,
  FileText,
  Download,
  Copy,
  ChevronLeft,
  ChevronRight,
  ScanText,
} from "lucide-react";
import type { OcrJob, OcrResult } from "../../shared/types";
import { api, post, response, download, notify } from "./api";
import { Header, Empty, Busy, Badge, date } from "./ui";
import { useEngines } from "./models";

interface Job extends OcrJob {
  canResume?: boolean;
  progress: number;
  attempts?: {
    id: string;
    engine: string;
    status: string;
    error: string;
    durationMs: number | null;
  }[];
}
interface Uploaded {
  id: string;
  name: string;
  pages: number;
  size: number;
}
export function Playground() {
  const [params] = useSearchParams();
  const { data: engines = [] } = useEngines();
  const [engine, setEngine] = useState(params.get("engine") || "auto");
  const [files, setFiles] = useState<Uploaded[]>([]);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [language, setLanguage] = useState("");
  const [pages, setPages] = useState("");
  const [grayscale, setGrayscale] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const client = useQueryClient();
  const { data: jobs = [] } = useQuery({
    queryKey: ["jobs"],
    queryFn: () => api<Job[]>("/v1/jobs"),
    refetchInterval: 2500,
  });
  async function upload(list: FileList | File[] | null) {
    if (!list?.length) return;
    setBusy(true);
    try {
      const uploaded: Uploaded[] = [];
      for (const file of Array.from(list)) {
        const body = new FormData();
        body.append("file", file);
        uploaded.push(
          await api<Uploaded>("/v1/files", { method: "POST", body }),
        );
      }
      setFiles((previous) => [...previous, ...uploaded]);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function run() {
    setBusy(true);
    try {
      let selection: number[] | undefined;
      if (pages.trim()) {
        selection = pages.split(",").flatMap((part) => {
          const range = part.trim().match(/^(\d+)(?:-(\d+))?$/);
          if (!range) throw new Error("Use page numbers such as 1,3-5.");
          const start = Number(range[1]);
          const end = Number(range[2] || range[1]);
          if (end < start || end - start > 10000)
            throw new Error("Invalid page range.");
          return Array.from({ length: end - start + 1 }, (_, i) => start + i);
        });
        selection = [...new Set(selection)];
      }
      const inputs = files.map((file) => ({
        fileId: file.id,
        engine,
        options: {
          ...(language ? { language } : {}),
          ...(selection ? { pages: selection } : {}),
          ...(grayscale ? { grayscale: true } : {}),
        },
      }));
      if (inputs.length === 1) {
        const job = await post<Job>("/v1/ocr", inputs[0]);
        setActive(job.id);
      } else {
        const batch = await post<{ jobs: Job[] }>("/v1/batches", {
          files: inputs,
        });
        setActive(batch.jobs[0]?.id || null);
      }
      setFiles([]);
      client.invalidateQueries({ queryKey: ["jobs"] });
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Header
        title="Playground"
        description="Upload a document and see which OCR engine serves it."
        actions={
          <>
            <Link className="button" to="/jobs">
              Job history
            </Link>
            <select
              aria-label="OCR engine"
              value={engine}
              onChange={(e) => setEngine(e.target.value)}
            >
              <option value="auto">Auto (fallback chain)</option>
              {engines.map((e) => (
                <option
                  key={e.id}
                  value={e.id}
                  disabled={!e.configured || !e.enabled}
                >
                  {e.name}
                  {!e.configured ? " · Not configured" : ""}
                </option>
              ))}
            </select>
          </>
        }
      />
      <section
        className={`dropzone ${drag ? "dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          void upload(e.dataTransfer.files);
        }}
      >
        <ScanText size={42} strokeWidth={1.2} />
        <h2>Drop your documents here</h2>
        <p>
          PDF, PNG, JPEG, WebP and TIFF
          <br />
          Process locally or through a configured provider.
        </p>
        <input
          ref={picker}
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,.webp,.tif,.tiff"
          multiple
          hidden
          onChange={(e) => {
            void upload(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          className="primary"
          disabled={busy}
          onClick={() => picker.current?.click()}
        >
          <Upload size={15} />
          {busy ? "Please wait…" : "Choose files"}
        </button>
      </section>
      {files.length > 0 && (
        <section className="card">
          {files.map((f) => (
            <div className="list-row" key={f.id}>
              <span>
                <FileText size={16} />
                {f.name}
                <Badge>{f.pages} pages</Badge>
              </span>
              <button
                onClick={() =>
                  setFiles(files.filter((item) => item.id !== f.id))
                }
              >
                Remove
              </button>
            </div>
          ))}
          <div className="form-grid">
            <label>
              Language
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              >
                <option value="">Engine default</option>
                <option value="eng">English (Tesseract / OCR.space)</option>
              </select>
            </label>
            <label>
              Pages
              <input
                placeholder="All pages, or 1,3-5"
                value={pages}
                onChange={(e) => setPages(e.target.value)}
              />
            </label>
            <label className="inline-label">
              <input
                type="checkbox"
                checked={grayscale}
                onChange={(e) => setGrayscale(e.target.checked)}
              />
              Grayscale (local engine)
            </label>
          </div>
          <button
            className="primary"
            disabled={busy}
            onClick={() => void run()}
          >
            Extract {files.length > 1 ? `${files.length} documents` : "text"}
          </button>
        </section>
      )}
      {active && <Result id={active} />}
      <h2 className="section-title">Recent jobs</h2>
      <JobTable jobs={jobs.slice(0, 8)} onSelect={setActive} />
    </>
  );
}
export function JobTable({
  jobs,
  onSelect,
}: {
  jobs: Job[];
  onSelect?: (id: string) => void;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Document</th>
            <th>Engine</th>
            <th>Status</th>
            <th>Created</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id}>
              <td>
                {onSelect ? (
                  <button
                    className="link-button"
                    onClick={() => onSelect(job.id)}
                  >
                    {job.filename}
                  </button>
                ) : (
                  <Link to={`/jobs/${job.id}`}>{job.filename}</Link>
                )}
              </td>
              <td>{job.engine}</td>
              <td>
                <span className={`status ${job.status}`}>
                  {job.status.replaceAll("_", " ")}
                </span>
              </td>
              <td className="muted">{date(job.createdAt)}</td>
              <td>
                <Link to={`/jobs/${job.id}`} aria-label="Open result">
                  <ChevronRight size={16} />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!jobs.length && (
        <Empty title="No documents processed yet">
          Your processing history will appear here.
        </Empty>
      )}
    </div>
  );
}
export function Jobs() {
  const [q, setQ] = useState("");
  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ["jobs", q],
    queryFn: () => api<Job[]>(`/v1/jobs?q=${encodeURIComponent(q)}`),
    refetchInterval: 3000,
  });
  return (
    <>
      <Header
        title="Jobs"
        description="Your documents, processing status and extraction results."
        actions={
          <Link className="button primary" to="/playground">
            Upload documents
          </Link>
        }
      />
      <input
        className="search-input"
        aria-label="Search jobs"
        placeholder="Search by document name or job ID…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {isLoading ? <Busy /> : <JobTable jobs={jobs} />}
    </>
  );
}
export function JobDetail() {
  const { id } = useParams();
  return (
    <>
      <Link className="back" to="/jobs">
        ← Job history
      </Link>
      <Result id={id!} />
    </>
  );
}
export function Result({ id }: { id: string }) {
  const client = useQueryClient();
  const { data: job, isLoading } = useQuery({
    queryKey: ["job", id],
    queryFn: () => api<Job>(`/v1/jobs/${id}`),
    refetchInterval: (query) =>
      ["queued", "running"].includes(query.state.data?.status || "")
        ? 1000
        : false,
  });
  const [tab, setTab] = useState("text");
  const [pageIndex, setPage] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const [mime, setMime] = useState("");
  useEffect(() => {
    setPage(0);
    setPreview(null);
    const abort = new AbortController();
    let url: string | undefined;
    if (job?.fileId)
      void response(`/v1/files/${job.fileId}/content`, { signal: abort.signal })
        .then((r) => {
          setMime(r.headers.get("content-type") || "");
          return r.blob();
        })
        .then((blob) => {
          if (!abort.signal.aborted) {
            url = URL.createObjectURL(blob);
            setPreview(url);
          }
        })
        .catch(() => {});
    return () => {
      abort.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [job?.fileId]);
  if (isLoading) return <Busy />;
  if (!job) return <Empty title="Result unavailable" />;
  const result = job.result as OcrResult | null;
  const page = result?.pages[pageIndex];
  return (
    <section className="result-section">
      <Header
        title={job.filename}
        description={`${job.engine} · ${job.status.replaceAll("_", " ")}${result?.cached ? " · Cached result" : ""}`}
        actions={
          ["queued", "running"].includes(job.status) ? (
            <button
              onClick={() =>
                void post(`/v1/jobs/${id}/cancel`)
                  .then(() =>
                    client.invalidateQueries({ queryKey: ["job", id] }),
                  )
                  .catch((e) => notify(e.message))
              }
            >
              Cancel job
            </button>
          ) : result ? (
            <div className="actions">
              <button
                onClick={() =>
                  void navigator.clipboard
                    .writeText(result.text)
                    .then(() => notify("Extracted text copied."))
                    .catch(() => notify("Clipboard unavailable."))
                }
              >
                <Copy size={14} />
                Copy
              </button>
              {[
                "txt",
                "md",
                "json",
                ...(result.pages.some((p) => p.tables.length) ? ["csv"] : []),
              ].map((format) => (
                <button
                  key={format}
                  onClick={() =>
                    void download(
                      `/v1/jobs/${id}/download?format=${format}`,
                      `ocr-result.${format}`,
                    ).catch((e) => notify(e.message))
                  }
                >
                  <Download size={13} />
                  {format.toUpperCase()}
                </button>
              ))}
            </div>
          ) : null
        }
      />
      {job.error && (
        <div className="error-panel">
          {job.error}
          {job.canResume && (
            <p>
              <button
                onClick={() =>
                  void post(`/v1/jobs/${id}/resume`)
                    .then(() =>
                      client.invalidateQueries({ queryKey: ["job", id] }),
                    )
                    .catch((e) => notify(e.message))
                }
              >
                Resume saved provider operation
              </button>
            </p>
          )}
        </div>
      )}
      {!result && ["queued", "running"].includes(job.status) && (
        <div className="card">
          <Busy />
          <p>
            {job.progress} pages processed. This job is saved and can be
            reopened later.
          </p>
        </div>
      )}
      {result && (
        <>
          <div className="section-line">
            <div className="tabs">
              {["text", "markdown", "json", "tables", "fields", "blocks"].map(
                (name) => (
                  <button
                    className={tab === name ? "selected" : ""}
                    key={name}
                    onClick={() => setTab(name)}
                  >
                    {name}
                  </button>
                ),
              )}
            </div>
            <div className="actions">
              <button
                aria-label="Previous page"
                disabled={pageIndex === 0}
                onClick={() => setPage(pageIndex - 1)}
              >
                <ChevronLeft size={15} />
              </button>
              <span>
                Page {page?.number} of {result.pages.length}
              </span>
              <button
                aria-label="Next page"
                disabled={pageIndex >= result.pages.length - 1}
                onClick={() => setPage(pageIndex + 1)}
              >
                <ChevronRight size={15} />
              </button>
            </div>
          </div>
          <div className="result-grid">
            <div className="source-preview">
              {preview ? (
                mime.includes("pdf") ? (
                  <iframe
                    title="Source document"
                    src={`${preview}#page=${page?.number || 1}`}
                  />
                ) : (
                  <img src={preview} alt="Source document" />
                )
              ) : (
                <p>Loading source preview…</p>
              )}
            </div>
            <div className="result-output">
              {tab === "tables" ? (
                page?.tables.length ? (
                  page.tables.map((table, i) => (
                    <div className="table-wrap" key={i}>
                      <table>
                        <tbody>
                          {table.rows.map((row, r) => (
                            <tr key={r}>
                              {row.map((cell, c) => (
                                <td key={c}>{cell}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))
                ) : (
                  <Empty title="No structured tables returned">
                    Table output depends on the selected engine.
                  </Empty>
                )
              ) : tab === "fields" ? (
                <pre>{JSON.stringify(page?.fields || {}, null, 2)}</pre>
              ) : tab === "blocks" ? (
                <pre>{JSON.stringify(page?.blocks || [], null, 2)}</pre>
              ) : (
                <pre>
                  {tab === "json"
                    ? JSON.stringify(page, null, 2)
                    : tab === "markdown"
                      ? page?.markdown
                      : page?.text}
                </pre>
              )}
            </div>
          </div>
        </>
      )}
      {Boolean(job.attempts?.length) && (
        <details className="attempts">
          <summary>Routing attempts ({job.attempts?.length})</summary>
          {job.attempts?.map((attempt) => (
            <div className="list-row" key={attempt.id}>
              <span>
                {attempt.engine} · {attempt.status}
              </span>
              <span className="muted">
                {attempt.error || `${attempt.durationMs ?? "—"} ms`}
              </span>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
