import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, put, post, download, notify } from "./api";
import { Modal, Busy, Toggle, date } from "./ui";
interface Preferences {
  retentionDays: number;
  cacheEnabled: boolean;
  language: string;
  maxPages: number;
  maxFileMB: number;
  defaultLanguage: string;
}
export function Settings({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api<{ preferences: Preferences }>("/api/settings"),
  });
  const [section, setSection] = useState("general");
  const [draft, setDraft] = useState<Preferences | null>(null);
  const [theme, setTheme] = useState(
    localStorage.getItem("freeocrapi.theme") || "system",
  );
  const [saving, setSaving] = useState(false);
  const prefs = draft || data?.preferences;
  async function save() {
    setSaving(true);
    try {
      if (prefs) await put("/api/settings", { preferences: prefs });
      localStorage.setItem("freeocrapi.theme", theme);
      window.dispatchEvent(new Event("theme-change"));
      client.invalidateQueries({ queryKey: ["settings"] });
      notify("Settings saved.");
      onClose();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal title="Settings" onClose={onClose}>
      <div className="tabs">
        {["general", "processing", "storage", "backups", "network"].map((s) => (
          <button
            key={s}
            className={s === section ? "selected" : ""}
            onClick={() => setSection(s)}
          >
            {s}
          </button>
        ))}
      </div>
      {isLoading || !prefs ? (
        <Busy />
      ) : section === "general" ? (
        <>
          <label>
            Appearance
            <select value={theme} onChange={(e) => setTheme(e.target.value)}>
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <label>
            Interface language
            <select
              value={prefs.language}
              onChange={(e) => setDraft({ ...prefs, language: e.target.value })}
            >
              <option value="en">English</option>
            </select>
          </label>
          <p className="small">
            Additional OCR language models are independent of the interface
            language.
          </p>
        </>
      ) : section === "processing" ? (
        <>
          <label>
            Default local OCR language
            <input
              value={prefs.defaultLanguage}
              onChange={(e) =>
                setDraft({ ...prefs, defaultLanguage: e.target.value })
              }
            />
          </label>
          <label>
            Maximum pages per document
            <input
              type="number"
              min={1}
              max={10000}
              value={prefs.maxPages}
              onChange={(e) =>
                setDraft({ ...prefs, maxPages: Number(e.target.value) })
              }
            />
          </label>
          <label>
            Maximum document size (MB)
            <input
              type="number"
              min={1}
              max={500}
              value={prefs.maxFileMB}
              onChange={(e) =>
                setDraft({ ...prefs, maxFileMB: Number(e.target.value) })
              }
            />
          </label>
          <p className="small">
            English recognition is bundled. Cloud adapters may impose smaller
            limits.
          </p>
          <LanguagePacks />
        </>
      ) : section === "storage" ? (
        <>
          <div className="list-row">
            <div>
              <h2>Response cache</h2>
              <p className="small">
                Reuse results for identical files, engine and options.
              </p>
            </div>
            <Toggle
              value={prefs.cacheEnabled}
              label="Response cache"
              onChange={(cacheEnabled) => setDraft({ ...prefs, cacheEnabled })}
            />
          </div>
          <label>
            Retention (days)
            <input
              type="number"
              min={1}
              max={3650}
              value={prefs.retentionDays}
              onChange={(e) =>
                setDraft({ ...prefs, retentionDays: Number(e.target.value) })
              }
            />
          </label>
          <button
            onClick={() => {
              if (
                confirm(
                  "Clear all cached OCR results? Completed job history is retained.",
                )
              )
                void post("/api/cache/clear")
                  .then(() => notify("Cache cleared."))
                  .catch((e) => notify(e.message));
            }}
          >
            Clear cache
          </button>
        </>
      ) : section === "network" ? (
        <Network />
      ) : (
        <Backups />
      )}
      <div className="actions bottom">
        <button onClick={onClose}>Cancel</button>
        <button
          className="primary"
          onClick={() => void save()}
          disabled={saving || !prefs}
        >
          Save settings
        </button>
      </div>
    </Modal>
  );
}
function LanguagePacks() {
  const { data: languages = [], refetch } = useQuery({
    queryKey: ["languages"],
    queryFn: () => api<string[]>("/api/languages"),
  });
  const [code, setCode] = useState("hin");
  const [busy, setBusy] = useState(false);
  return (
    <>
      <h2>Installed OCR languages</h2>
      <p>{languages.join(", ")}</p>
      <label>
        Install a Tesseract language code
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="hin, fra, deu, spa…"
        />
      </label>
      <button
        disabled={busy || !/^[a-z_]{3,20}$/.test(code)}
        onClick={async () => {
          setBusy(true);
          try {
            await post(`/api/languages/${code}`);
            await refetch();
            notify("Language pack installed.");
          } catch (e) {
            notify((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Downloading…" : "Install language pack"}
      </button>
      <p className="small">
        Models download from the official Tesseract tessdata_fast repository.
        Combine installed codes with + for multilingual recognition.
      </p>
    </>
  );
}
function Network() {
  const { data } = useQuery({
    queryKey: ["network"],
    queryFn: () => api<{ proxyConfigured: boolean }>("/api/network"),
  });
  const [proxy, setProxy] = useState("");
  const client = useQueryClient();
  return (
    <>
      <p>
        HTTP proxy for REST-based provider requests. AWS SDK connections use
        their own transport configuration.
      </p>
      <p>
        Status:{" "}
        {data?.proxyConfigured ? "Proxy configured" : "Direct connection"}
      </p>
      <label>
        Proxy URL
        <input
          type="password"
          autoComplete="off"
          value={proxy}
          onChange={(e) => setProxy(e.target.value)}
          placeholder="http://127.0.0.1:7890"
        />
      </label>
      <button
        onClick={() =>
          void put("/api/network", { proxyUrl: proxy })
            .then(() => {
              setProxy("");
              client.invalidateQueries({ queryKey: ["network"] });
              notify("Network setting saved.");
            })
            .catch((e) => notify(e.message))
        }
      >
        {proxy ? "Save proxy" : "Use direct connection"}
      </button>
    </>
  );
}
function Backups() {
  const [password, setPassword] = useState("");
  const { data: backups = [], refetch } = useQuery({
    queryKey: ["backups"],
    queryFn: () =>
      api<{ name: string; createdAt: string; size: number }[]>("/api/backups"),
  });
  return (
    <>
      <p>
        Encrypted backups contain the database, documents and credential
        encryption key. Keep downloaded copies private.
      </p>
      <label>
        Backup password (at least 12 characters)
        <input
          type="password"
          value={password}
          minLength={12}
          autoComplete="new-password"
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <button
        disabled={password.length < 12}
        onClick={() =>
          void post("/api/backups", { password })
            .then(() => refetch())
            .catch((e) => notify(e.message))
        }
      >
        Create encrypted backup
      </button>
      <label className="button">
        Restore encrypted backup
        <input
          type="file"
          accept=".ocrbackup,application/json"
          hidden
          disabled={password.length < 12}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            if (
              !confirm(
                "Restore this backup on the next restart? The current installation will be backed up first.",
              )
            )
              return;
            try {
              const body = new FormData();
              body.append("file", file);
              body.append("password", password);
              const data = await api<{ message: string }>(
                "/api/backups/restore",
                { method: "POST", body },
              );
              notify(data.message);
            } catch (error) {
              notify((error as Error).message);
            }
            e.target.value = "";
          }}
        />
      </label>
      {backups.map((backup) => (
        <div className="list-row" key={backup.name}>
          <div>
            <strong>{date(backup.createdAt)}</strong>
            <span className="subtext">
              {(backup.size / 1024).toFixed(0)} KB
            </span>
          </div>
          <button
            onClick={() =>
              void download(
                `/api/backups/${encodeURIComponent(backup.name)}`,
                backup.name,
              ).catch((e) => notify(e.message))
            }
          >
            Download
          </button>
        </div>
      ))}
    </>
  );
}
