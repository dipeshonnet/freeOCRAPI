import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Copy,
  ChevronDown,
  KeyRound,
  Trash2,
  Search,
} from "lucide-react";
import type { ProviderCredential } from "../../shared/types";
import { api, post, notify, download } from "./api";
import { useEngines } from "./models";
import { Header, Modal, Toggle, Busy, Badge, Empty } from "./ui";
export function Keys() {
  const client = useQueryClient();
  const { data: engines = [] } = useEngines();
  const { data: keys = [], isLoading } = useQuery({
    queryKey: ["keys"],
    queryFn: () => api<ProviderCredential[]>("/api/keys"),
  });
  const [add, setAdd] = useState(false);
  const [selected, setSelected] = useState("llamaparse");
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState<Record<string, string>>({});
  const [advanced, setAdvanced] = useState("{}");
  const [pageCap, setPages] = useState(0);
  const [requestCap, setRequests] = useState(0);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState("providers");
  const [revealed, setRevealed] = useState(false);
  const { data: unified } = useQuery({
    queryKey: ["unified-key"],
    queryFn: () => api<{ apiKey: string }>("/api/settings/api-key"),
  });
  const refresh = () => {
    client.invalidateQueries({ queryKey: ["keys"] });
    client.invalidateQueries({ queryKey: ["engines"] });
  };
  const create = useMutation({
    mutationFn: () => {
      const extra = JSON.parse(advanced) as Record<string, string>;
      if (Object.values(extra).some((v) => typeof v !== "string"))
        throw new Error("Additional credential options must be string values.");
      return post("/api/keys", {
        engine: selected,
        label: label || engines.find((e) => e.id === selected)?.name,
        secret: { ...secret, ...extra },
        pageCap,
        requestCap,
      });
    },
    onSuccess: () => {
      refresh();
      setAdd(false);
      setSecret({});
      setLabel("");
      setAdvanced("{}");
    },
  });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api(`/api/keys/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/keys/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });
  const definition = engines.find((e) => e.id === selected);
  return (
    <>
      <Header
        title="Keys"
        description="Provider credentials and the unified API key your apps connect with."
        actions={
          <>
            <button
              onClick={() =>
                void post("/api/keys/check")
                  .then(() => {
                    refresh();
                    notify("Credential checks complete.");
                  })
                  .catch((e) => notify(e.message))
              }
            >
              Check all
            </button>
            <button
              onClick={() =>
                void download(
                  "/api/keys/export",
                  "freeocrapi-credentials.encrypted.json",
                ).catch((e) => notify(e.message))
              }
            >
              Export
            </button>
            <button className="primary" onClick={() => setAdd(true)}>
              <Plus size={14} />
              Add key
            </button>
            <div className="tabs">
              {["providers", "quota signals", "unified API key"].map((t) => (
                <button
                  key={t}
                  className={tab === t ? "selected" : ""}
                  onClick={() => setTab(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </>
        }
      />
      {tab === "unified API key" ? (
        <section className="card">
          <h2>Your unified OCR API key</h2>
          <p>
            Use this bearer token for processing APIs. Dashboard administration
            uses your account session.
          </p>
          <div className="key-line">
            <code>
              {revealed
                ? unified?.apiKey
                : "freeocrapi-••••••••••••••••••••••••"}
            </code>
            <button onClick={() => setRevealed(!revealed)}>
              {revealed ? "Hide" : "Reveal"}
            </button>
            <button
              aria-label="Copy API key"
              onClick={() => {
                if (unified)
                  void navigator.clipboard
                    .writeText(unified.apiKey)
                    .then(() => notify("API key copied."))
                    .catch(() => notify("Clipboard unavailable."));
              }}
            >
              <Copy size={14} />
            </button>
          </div>
          <p>
            <code>{location.origin}/v1/ocr</code>
          </p>
          <button
            onClick={() => {
              if (
                confirm(
                  "Rotate your unified API key? Existing clients will need the new key.",
                )
              )
                void post("/api/settings/api-key/rotate")
                  .then(() =>
                    client.invalidateQueries({ queryKey: ["unified-key"] }),
                  )
                  .catch((e) => notify(e.message));
            }}
          >
            Rotate key
          </button>
        </section>
      ) : tab === "quota signals" ? (
        <section className="card">
          <h2>Monthly credential limits</h2>
          <p>
            Zero means unlimited. Limits are configured admission guards,
            independent of provider billing.
          </p>
          <table>
            <thead>
              <tr>
                <th>Credential</th>
                <th>Request cap</th>
                <th>Page cap</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td>{k.label}</td>
                  <td>{k.requestCap || "Unlimited"}</td>
                  <td>{k.pageCap || "Unlimited"}</td>
                  <td>{k.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : (
        <>
          <div className="toolbar">
            <div className="search">
              <Search size={15} />
              <input
                aria-label="Filter credentials"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter providers or keys…"
              />
            </div>
            <span className="muted">
              {engines.length} engines · {keys.length} keys
            </span>
          </div>
          {isLoading ? (
            <Busy />
          ) : (
            engines
              .filter((e) =>
                `${e.name} ${e.provider}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              )
              .map((engine) => (
                <details className="provider-row" key={engine.id}>
                  <summary>
                    <Toggle
                      value={engine.enabled}
                      label={`Enable ${engine.name}`}
                      onChange={(enabled) =>
                        void api(`/api/models/${engine.id}`, {
                          method: "PATCH",
                          body: JSON.stringify({ enabled }),
                        })
                          .then(refresh)
                          .catch((e) => notify(e.message))
                      }
                    />
                    <strong>{engine.name}</strong>
                    <Badge>
                      {keys.filter((k) => k.engine === engine.id).length}
                    </Badge>
                    <span className={`status ${engine.status}`}>
                      {engine.status}
                    </span>
                    <ChevronDown size={15} />
                  </summary>
                  <div className="provider-body">
                    {engine.id === "tesseract" ? (
                      <p>Built-in local engine. No credential required.</p>
                    ) : keys.filter((k) => k.engine === engine.id).length ? (
                      keys
                        .filter((k) => k.engine === engine.id)
                        .map((key) => (
                          <div className="credential-row" key={key.id}>
                            <KeyRound size={15} />
                            <strong>{key.label}</strong>
                            <span className={`status ${key.status}`}>
                              {key.status}
                            </span>
                            <div className="spacer" />
                            <Toggle
                              label={`Enable ${key.label}`}
                              value={key.enabled}
                              onChange={(enabled) =>
                                toggle.mutate({ id: key.id, enabled })
                              }
                            />
                            <button
                              aria-label={`Check ${key.label}`}
                              onClick={() =>
                                void post(`/api/keys/${key.id}/check`)
                                  .then(refresh)
                                  .catch((e) => notify(e.message))
                              }
                            >
                              Check
                            </button>
                            <button
                              aria-label={`Delete ${key.label}`}
                              onClick={() => {
                                if (confirm(`Delete credential ${key.label}?`))
                                  remove.mutate(key.id);
                              }}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        ))
                    ) : (
                      <Empty title="No credentials configured">
                        <button
                          onClick={() => {
                            setSelected(engine.id);
                            setAdd(true);
                          }}
                        >
                          Add {engine.name} credential
                        </button>
                      </Empty>
                    )}
                  </div>
                </details>
              ))
          )}
        </>
      )}
      {add && (
        <Modal title="Add provider credential" onClose={() => setAdd(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <label>
              Provider
              <select
                value={selected}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setSecret({});
                }}
              >
                {engines
                  .filter((e) => e.id !== "tesseract")
                  .map((e) => (
                    <option value={e.id} key={e.id}>
                      {e.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Label
              <input
                placeholder={definition?.name}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </label>
            {definition?.credentialFields.map((field) => (
              <label key={field}>
                {field}
                {field === "serviceAccount" ? (
                  <textarea
                    required
                    rows={5}
                    value={secret[field] || ""}
                    onChange={(e) =>
                      setSecret({ ...secret, [field]: e.target.value })
                    }
                    placeholder="Paste service account JSON"
                  />
                ) : (
                  <input
                    required
                    type={/key|secret/i.test(field) ? "password" : "text"}
                    autoComplete="off"
                    value={secret[field] || ""}
                    onChange={(e) =>
                      setSecret({ ...secret, [field]: e.target.value })
                    }
                  />
                )}
              </label>
            ))}
            <div className="form-grid">
              <label>
                Monthly request cap
                <input
                  type="number"
                  min={0}
                  value={requestCap}
                  onChange={(e) => setRequests(Number(e.target.value))}
                />
              </label>
              <label>
                Monthly page cap
                <input
                  type="number"
                  min={0}
                  value={pageCap}
                  onChange={(e) => setPages(Number(e.target.value))}
                />
              </label>
            </div>
            <details>
              <summary>Additional provider options</summary>
              <p className="small">
                JSON object with string values, such as tier, model, endpoint,
                maxFileMB, maxPages or sessionToken.
              </p>
              <textarea
                aria-label="Additional provider options"
                rows={4}
                value={advanced}
                onChange={(e) => setAdvanced(e.target.value)}
              />
            </details>
            <p className="small">
              Credentials are encrypted in your local database. Cloud providers
              may charge for enabled accounts.
            </p>
            <div className="actions bottom">
              <button type="button" onClick={() => setAdd(false)}>
                Cancel
              </button>
              <button className="primary" disabled={create.isPending}>
                Save credential
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
