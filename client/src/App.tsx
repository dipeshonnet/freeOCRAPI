import { useEffect, useState } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  NavLink,
  Link,
  useNavigate,
} from "react-router-dom";
import {
  QueryClient,
  QueryClientProvider,
  MutationCache,
  QueryCache,
} from "@tanstack/react-query";
import {
  Search,
  MoreHorizontal,
  Settings as SettingsIcon,
  LogOut,
  Menu as MenuIcon,
} from "lucide-react";
import { Auth } from "./auth";
import { token, logout, post, notify, saveToken } from "./api";
import { TrayPopover } from "./tray";
import { Menu, Modal, Empty } from "./ui";
import { Engines, EngineDetail, Profiles, Rules, tabs } from "./models";
import { Playground, Jobs, JobDetail } from "./playground";
import { Keys } from "./keys";
import { Analytics, Logs, SearchDocuments, Agents, Catalog } from "./insights";
import { Settings } from "./settings";
const client = new QueryClient({
  defaultOptions: { queries: { staleTime: 15000, retry: 1 } },
  mutationCache: new MutationCache({
    onError: (error) => notify(error.message),
  }),
  queryCache: new QueryCache({ onError: (error) => notify(error.message) }),
});
function Notices() {
  const [message, setMessage] = useState("");
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const listener = (event: Event) => {
      setMessage((event as CustomEvent<string>).detail);
      clearTimeout(timer);
      timer = setTimeout(() => setMessage(""), 6000);
    };
    window.addEventListener("notice", listener);
    return () => {
      window.removeEventListener("notice", listener);
      clearTimeout(timer);
    };
  }, []);
  return message ? (
    <div role="status" className="toast">
      {message}
      <button onClick={() => setMessage("")} aria-label="Dismiss notification">
        ×
      </button>
    </div>
  ) : null;
}
function Theme() {
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const choice = localStorage.getItem("freeocrapi.theme") || "system";
      document.documentElement.dataset.theme =
        choice === "system" ? (media.matches ? "dark" : "light") : choice;
    };
    apply();
    media.addEventListener("change", apply);
    window.addEventListener("theme-change", apply);
    return () => {
      media.removeEventListener("change", apply);
      window.removeEventListener("theme-change", apply);
    };
  }, []);
  return null;
}
const commands = [
  ...tabs,
  ["/playground", "Playground"],
  ["/jobs", "Job history"],
  ["/keys", "Keys"],
  ["/agents", "Agents & integrations"],
  ["/analytics", "Analytics"],
  ["/logs", "Request logs"],
  ["/search", "Document search"],
  ["/catalog", "Catalog & updates"],
];
function Shell() {
  const [settings, setSettings] = useState(false);
  const [command, setCommand] = useState(false);
  const [search, setSearch] = useState("");
  const [mobile, setMobile] = useState(false);
  const navigate = useNavigate();
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommand((value) => !value);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  return (
    <>
      <header>
        <Link className="brand" to="/models/ocr">
          <span className="brand-dot" />
          FreeOCRapi
        </Link>
        <nav className={mobile ? "expanded" : ""}>
          <div className="nav-group">
            <NavLink to="/models">Engines</NavLink>
            <Menu label="">
              <div>
                {tabs.map(([to, label]) => (
                  <Link key={to} to={to} onClick={() => setMobile(false)}>
                    {label}
                  </Link>
                ))}
              </div>
            </Menu>
          </div>
          <NavLink to="/playground" onClick={() => setMobile(false)}>
            Playground
          </NavLink>
          <NavLink to="/keys" onClick={() => setMobile(false)}>
            Keys
          </NavLink>
          <NavLink to="/agents" onClick={() => setMobile(false)}>
            Agents
          </NavLink>
          <div className="nav-group">
            <NavLink to="/analytics">Analytics</NavLink>
            <Menu label="">
              <Link to="/logs">Request logs</Link>
              <Link to="/search">Document search</Link>
              <Link to="/jobs">Job history</Link>
            </Menu>
          </div>
          <NavLink to="/catalog" onClick={() => setMobile(false)}>
            Catalog
          </NavLink>
        </nav>
        <div className="header-actions">
          <button
            className="icon-button command-trigger"
            aria-label="Open command palette"
            onClick={() => setCommand(true)}
          >
            <Search size={16} />
            <kbd>⌘K</kbd>
          </button>
          <Menu label={<MoreHorizontal size={20} />}>
            <button onClick={() => setSettings(true)}>
              <SettingsIcon size={14} />
              Settings
            </button>
            <Link to="/jobs">Job history</Link>
            <Link to="/search">Document search</Link>
            {!window.freeocrapi && (
              <button
                onClick={() =>
                  void post("/api/auth/logout")
                    .catch(() => {})
                    .finally(() => {
                      client.clear();
                      logout();
                    })
                }
              >
                <LogOut size={14} />
                Sign out
              </button>
            )}
          </Menu>
          <button
            className="icon-button mobile-toggle"
            aria-label="Toggle navigation"
            onClick={() => setMobile(!mobile)}
          >
            <MenuIcon size={20} />
          </button>
        </div>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Navigate to="/models/ocr" replace />} />
          <Route
            path="/models"
            element={<Navigate to="/models/ocr" replace />}
          />
          {["ocr", "image", "batch", "handwriting", "extraction"].map(
            (path) => (
              <Route
                key={path}
                path={`/models/${path}`}
                element={<Engines />}
              />
            ),
          )}
          <Route path="/models/detail/:id" element={<EngineDetail />} />
          <Route path="/models/profiles" element={<Profiles />} />
          <Route path="/models/rules" element={<Rules />} />
          <Route path="/playground" element={<Playground />} />
          <Route path="/jobs" element={<Jobs />} />
          <Route path="/jobs/:id" element={<JobDetail />} />
          <Route path="/keys" element={<Keys />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/logs" element={<Logs />} />
          <Route path="/search" element={<SearchDocuments />} />
          <Route path="/catalog" element={<Catalog />} />
          <Route path="/premium" element={<Navigate to="/catalog" replace />} />
          <Route
            path="*"
            element={
              <Empty title="Page not found">
                <Link to="/models/ocr">Return to engines</Link>
              </Empty>
            }
          />
        </Routes>
      </main>
      {settings && <Settings onClose={() => setSettings(false)} />}{" "}
      {command && (
        <Modal title="Go to…" onClose={() => setCommand(false)}>
          <input
            autoFocus
            placeholder="Search pages…"
            aria-label="Search pages"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="command-list">
            {commands
              .filter(([, label]) =>
                label.toLowerCase().includes(search.toLowerCase()),
              )
              .map(([to, label]) => (
                <button
                  key={to}
                  onClick={() => {
                    navigate(to);
                    setCommand(false);
                    setSearch("");
                  }}
                >
                  {label}
                </button>
              ))}
          </div>
        </Modal>
      )}
    </>
  );
}
function Application() {
  const [session, setSession] = useState(token);
  useEffect(() => {
    if (window.freeocrapi)
      void window.freeocrapi
        .session()
        .then(saveToken)
        .catch(() => notify("Desktop sign-in failed. Reopen the dashboard."));
    const listener = () => {
      const current = token();
      setSession(current);
      if (!current && window.freeocrapi)
        void window.freeocrapi
          .session()
          .then(saveToken)
          .catch(() => notify("Desktop session could not be renewed."));
    };
    window.addEventListener("auth-change", listener);
    return () => window.removeEventListener("auth-change", listener);
  }, []);
  return (
    <>
      <Theme />
      {session && location.pathname === "/desktop-tray" ? (
        <TrayPopover />
      ) : session ? (
        <BrowserRouter>
          <Shell />
        </BrowserRouter>
      ) : (
        <Auth />
      )}
      <Notices />
    </>
  );
}
export default function App() {
  return (
    <QueryClientProvider client={client}>
      <Application />
    </QueryClientProvider>
  );
}
