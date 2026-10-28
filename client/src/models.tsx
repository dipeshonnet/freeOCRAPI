import { useState } from "react";
import { Link, useParams, useLocation } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Search,
  ChevronRight,
  ArrowUp,
  ArrowDown,
  Plus,
  Trash2,
} from "lucide-react";
import type { Capability, Engine, Profile, Strategy } from "../../shared/types";
import { api, put } from "./api";
import { Header, Badge, Toggle, Busy, Empty, show } from "./ui";
export interface EngineInfo extends Engine {
  credentialFields: string[];
  docs: string;
  priority: number;
}
export const useEngines = () =>
  useQuery({
    queryKey: ["engines"],
    queryFn: () => api<EngineInfo[]>("/api/models"),
    refetchInterval: 5000,
  });
export const strategies: Record<Strategy, string> = {
  manual: "Manual",
  balanced: "Balanced",
  quality: "Quality preferred",
  fastest: "Fastest",
  reliable: "Most reliable",
  custom: "Custom",
};
export const tabs = [
  ["/models/ocr", "Text OCR"],
  ["/models/image", "Images"],
  ["/models/batch", "Documents"],
  ["/models/handwriting", "Handwriting"],
  ["/models/extraction", "Tables & forms"],
  ["/models/rules", "Rules"],
  ["/models/profiles", "Profiles"],
];
export function ModelTabs() {
  const location = useLocation();
  return (
    <div className="tabs">
      {tabs.map(([to, label]) => (
        <Link
          className={location.pathname === to ? "selected" : ""}
          key={to}
          to={to}
        >
          {label}
        </Link>
      ))}
    </div>
  );
}
export function Engines() {
  const { data: engines, isLoading } = useEngines();
  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: () =>
      api<{
        routing: {
          strategy: Strategy;
          weights: { reliability: number; speed: number; quality: number };
        };
      }>("/api/settings"),
  });
  const client = useQueryClient();
  const [search, setSearch] = useState("");
  const [configured, setConfigured] = useState(false);
  const location = useLocation();
  const setStrategy = useMutation({
    mutationFn: (strategy: Strategy) =>
      put("/api/settings", {
        routing: {
          strategy,
          weights: settings?.routing.weights || {
            reliability: 0.5,
            speed: 0.25,
            quality: 0.25,
          },
        },
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["settings"] }),
  });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api(`/api/models/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["engines"] }),
  });
  if (isLoading) return <Busy />;
  const cap: Capability | undefined = location.pathname.endsWith("handwriting")
    ? "handwriting"
    : location.pathname.endsWith("extraction")
      ? "tables"
      : location.pathname.endsWith("batch")
        ? "pdf"
        : undefined;
  const rows = (engines || []).filter(
    (e) =>
      (!cap || e.capabilities.includes(cap)) &&
      (!configured || e.configured) &&
      `${e.name} ${e.provider}`.toLowerCase().includes(search.toLowerCase()),
  );
  const total = (engines || []).reduce((sum, e) => sum + e.pagesUsed, 0);
  return (
    <>
      <Header
        title="Engines"
        description="One document, one engine. Route through your available OCR providers."
        actions={<ModelTabs />}
      />
      <section className="card">
        <div className="section-line">
          <h2>Monthly OCR usage</h2>
          <span>
            <strong>{total.toLocaleString()}</strong> pages processed
          </span>
        </div>
        <div className="budget-bar">
          {total > 0 ? (
            (engines || [])
              .filter((e) => e.pagesUsed)
              .map((e, i) => (
                <span
                  key={e.id}
                  style={{
                    width: `${(100 * e.pagesUsed) / total}%`,
                    background: `hsl(${i * 48} 55% 55%)`,
                  }}
                  title={`${e.name}: ${e.pagesUsed} pages`}
                />
              ))
          ) : (
            <span style={{ width: "100%", background: "var(--border)" }} />
          )}
        </div>
        <div className="budget-legend">
          {(engines || []).map((e, i) => (
            <div key={e.id}>
              <span
                className="dot"
                style={{ background: `hsl(${i * 48} 55% 55%)` }}
              />
              {e.name}
              <span className="muted">{e.pagesUsed.toLocaleString()}</span>
            </div>
          ))}
        </div>
        <p className="small">
          Usage reflects completed attempts. Provider allowances and credits
          vary; an unknown allowance is not shown as free capacity.
        </p>
      </section>
      <section className="card">
        <h2>Routing strategy</h2>
        <div className="tabs">
          {Object.entries(strategies).map(([key, label]) => (
            <button
              className={settings?.routing.strategy === key ? "selected" : ""}
              key={key}
              disabled={setStrategy.isPending}
              onClick={() => setStrategy.mutate(key as Strategy)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="small">
          Automatic routing uses enabled engines, compatible capabilities,
          healthy credentials and available quota. Quality preference preserves
          profile order until benchmark ratings are configured.
        </p>
      </section>
      <div className="toolbar">
        <div className="search">
          <Search size={16} />
          <input
            aria-label="Search engines"
            placeholder="Search engines or providers…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <label className="inline-label">
          <input
            type="checkbox"
            checked={configured}
            onChange={(e) => setConfigured(e.target.checked)}
          />
          Configured only
        </label>
        <Link className="button" to="/keys">
          Manage credentials
        </Link>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Engine</th>
              <th>Reliability</th>
              <th>Latency</th>
              <th>Capabilities</th>
              <th>Status</th>
              <th>On</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((e, i) => (
              <tr key={e.id}>
                <td className="muted">{i + 1}</td>
                <td>
                  <Link className="engine-name" to={`/models/detail/${e.id}`}>
                    {e.name}
                  </Link>
                  <span className="subtext">
                    {e.provider}
                    {e.local ? " · Local" : ""}
                  </span>
                </td>
                <td>
                  {e.reliability === null
                    ? "—"
                    : `${Math.round(e.reliability * 100)}%`}
                </td>
                <td>{show(e.latencyMs, " ms")}</td>
                <td>
                  <div className="badges">
                    {e.capabilities.map((c) => (
                      <Badge key={c}>{c}</Badge>
                    ))}
                  </div>
                </td>
                <td>
                  <span className={`status ${e.status}`}>{e.status}</span>
                </td>
                <td>
                  <Toggle
                    value={e.enabled}
                    onChange={(enabled) => toggle.mutate({ id: e.id, enabled })}
                    disabled={toggle.isPending}
                    label={`Enable ${e.name}`}
                  />
                </td>
                <td>
                  <Link
                    to={`/models/detail/${e.id}`}
                    aria-label={`View ${e.name}`}
                  >
                    <ChevronRight size={16} />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && (
          <Empty title="No matching engines">Try another filter.</Empty>
        )}
      </div>
    </>
  );
}
export function EngineDetail() {
  const { id } = useParams();
  const { data, isLoading } = useEngines();
  if (isLoading) return <Busy />;
  const engine = data?.find((e) => e.id === id);
  if (!engine) return <Empty title="Engine not found" />;
  return (
    <>
      <Link className="back" to="/models/ocr">
        ← Engines
      </Link>
      <Header
        title={engine.name}
        description={engine.description}
        actions={
          <Link
            className="button primary"
            to={`/playground?engine=${engine.id}`}
          >
            Test engine
          </Link>
        }
      />
      <div className="metric-grid">
        {[
          ["Provider", engine.provider],
          ["Status", engine.status],
          ["Pages this month", engine.pagesUsed],
          ["Requests", engine.requests],
        ].map(([label, value]) => (
          <section className="card metric" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </section>
        ))}
      </div>
      <section className="card">
        <h2>Capabilities</h2>
        <div className="badges">
          {engine.capabilities.map((c) => (
            <Badge key={c}>{c}</Badge>
          ))}
        </div>
        <p>Supported formats: {engine.formats.join(", ").toUpperCase()}</p>
        <p>
          {engine.local
            ? "Runs locally or through your configured local service."
            : "Documents are sent to the configured cloud provider."}
        </p>
        <div className="actions">
          <Link className="button" to="/keys">
            Configure credentials
          </Link>
          <a
            className="button"
            href={engine.docs}
            target="_blank"
            rel="noreferrer"
          >
            Provider documentation ↗
          </a>
        </div>
      </section>
    </>
  );
}
export function Profiles() {
  const client = useQueryClient();
  const { data: engines } = useEngines();
  const { data: profiles, isLoading } = useQuery({
    queryKey: ["profiles"],
    queryFn: () => api<Profile[]>("/api/profiles"),
  });
  const [draft, setDraft] = useState<Profile | null>(null);
  const save = useMutation({
    mutationFn: (profile: Profile) =>
      put(`/api/profiles/${profile.id}`, profile),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["profiles"] });
      setDraft(null);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/profiles/${id}`, { method: "DELETE" }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["profiles"] }),
  });
  if (isLoading) return <Busy />;
  function move(index: number, direction: number) {
    if (!draft) return;
    const next = [...draft.engines];
    const destination = index + direction;
    if (destination < 0 || destination >= next.length) return;
    [next[index], next[destination]] = [next[destination], next[index]];
    setDraft({ ...draft, engines: next });
  }
  return (
    <>
      <Header
        title="Routing profiles"
        description="Named fallback chains. Only one engine processes a document at a time."
        actions={<ModelTabs />}
      />
      {draft ? (
        <section className="card">
          <label>
            Profile name
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label>
            Strategy
            <select
              value={draft.strategy}
              onChange={(e) =>
                setDraft({ ...draft, strategy: e.target.value as Strategy })
              }
            >
              {Object.entries(strategies).map(([key, label]) => (
                <option value={key} key={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <h2>Fallback order</h2>
          {draft.engines.map((id, i) => (
            <div className="list-row" key={id}>
              <span>
                {i + 1}. {engines?.find((e) => e.id === id)?.name || id}
              </span>
              <div className="actions">
                <button
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  aria-label="Move engine up"
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  onClick={() => move(i, 1)}
                  disabled={i === draft.engines.length - 1}
                  aria-label="Move engine down"
                >
                  <ArrowDown size={14} />
                </button>
                <button
                  onClick={() =>
                    setDraft({
                      ...draft,
                      engines: draft.engines.filter((e) => e !== id),
                    })
                  }
                  aria-label="Remove engine"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
          <select
            aria-label="Add engine"
            value=""
            onChange={(e) => {
              if (e.target.value)
                setDraft({
                  ...draft,
                  engines: [...draft.engines, e.target.value],
                });
            }}
          >
            <option value="">Add an engine…</option>
            {engines
              ?.filter((e) => !draft.engines.includes(e.id))
              .map((e) => (
                <option value={e.id} key={e.id}>
                  {e.name}
                </option>
              ))}
          </select>
          <div className="actions bottom">
            <button onClick={() => setDraft(null)}>Cancel</button>
            <button
              className="primary"
              disabled={!draft.name.trim() || save.isPending}
              onClick={() => save.mutate(draft)}
            >
              Save profile
            </button>
          </div>
        </section>
      ) : (
        <>
          <button
            onClick={() =>
              setDraft({
                id: crypto.randomUUID(),
                name: "New profile",
                engines: [],
                strategy: "manual",
              })
            }
          >
            <Plus size={14} />
            New profile
          </button>
          {profiles?.map((p) => (
            <section className="card" key={p.id}>
              <div className="section-line">
                <div>
                  <h2>{p.name}</h2>
                  <Badge>{strategies[p.strategy]}</Badge>
                </div>
                <div className="actions">
                  <button onClick={() => setDraft({ ...p })}>Edit chain</button>
                  {p.id !== "default" && (
                    <button
                      aria-label={`Delete ${p.name}`}
                      onClick={() => {
                        if (confirm(`Delete ${p.name}?`)) remove.mutate(p.id);
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
              <p>
                {p.engines
                  .map((id) => engines?.find((e) => e.id === id)?.name || id)
                  .join(" → ") || "Empty chain: no engine will be used."}
              </p>
            </section>
          ))}
        </>
      )}
    </>
  );
}
interface Rule {
  id: string;
  format: string;
  minPages: number;
  profile: string;
}
export function Rules() {
  const client = useQueryClient();
  const { data: rules = [], isLoading } = useQuery({
    queryKey: ["rules"],
    queryFn: () => api<Rule[]>("/api/rules"),
  });
  const { data: profiles = [] } = useQuery({
    queryKey: ["profiles"],
    queryFn: () => api<Profile[]>("/api/profiles"),
  });
  const save = useMutation({
    mutationFn: (value: Rule[]) => put("/api/rules", value),
    onSuccess: () => client.invalidateQueries({ queryKey: ["rules"] }),
  });
  const [format, setFormat] = useState("pdf");
  const [minPages, setMin] = useState(1);
  const [profile, setProfile] = useState("default");
  return (
    <>
      <Header
        title="Routing rules"
        description="First matching rule chooses a profile for automatic requests. Explicit engine selections stay pinned."
        actions={<ModelTabs />}
      />
      <section className="card">
        <div className="form-grid">
          <label>
            Document format
            <select value={format} onChange={(e) => setFormat(e.target.value)}>
              {["any", "pdf", "png", "jpeg", "webp", "tiff"].map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </label>
          <label>
            At least this many pages
            <input
              type="number"
              min={1}
              value={minPages}
              onChange={(e) => setMin(Number(e.target.value))}
            />
          </label>
          <label>
            Use profile
            <select
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button
          disabled={save.isPending || minPages < 1}
          onClick={() =>
            save.mutate([
              ...rules,
              { id: crypto.randomUUID(), format, minPages, profile },
            ])
          }
        >
          Add rule
        </button>
      </section>
      {isLoading ? (
        <Busy />
      ) : (
        rules.map((rule, i) => (
          <div className="list-row" key={rule.id}>
            <span>
              {i + 1}. {rule.format.toUpperCase()} · {rule.minPages}+ pages →{" "}
              {profiles.find((p) => p.id === rule.profile)?.name ||
                rule.profile}
            </span>
            <button
              aria-label="Remove rule"
              onClick={() => save.mutate(rules.filter((r) => r.id !== rule.id))}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))
      )}
      {!rules.length && (
        <Empty title="No routing rules">
          Automatic requests use the default profile.
        </Empty>
      )}
    </>
  );
}
