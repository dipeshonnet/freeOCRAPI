import { useState, type FormEvent } from "react";
import { api, post, saveToken, notify } from "./api";
import { useQuery } from "@tanstack/react-query";
import { Busy } from "./ui";
export function Auth() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["auth-status"],
    queryFn: () => api<{ setupRequired: boolean }>("/api/auth/status"),
    retry: false,
  });
  const [mode, setMode] = useState<"login" | "forgot" | "reset">("login");
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      if (mode === "forgot") {
        await post("/api/auth/forgot-password");
        notify("Read the reset code from the server console.");
        setMode("reset");
        return;
      }
      const result = await post<{ token: string }>(
        `/api/auth/${mode === "reset" ? "reset-password" : data?.setupRequired ? "setup" : "login"}`,
        mode === "reset"
          ? { code, password }
          : { email, password, setupCode: code },
      );
      saveToken(result.token);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (isLoading) return <Busy />;
  if (error)
    return (
      <div className="auth-card">
        <h1>Cannot reach FreeOCRapi</h1>
        <p>{error.message}</p>
        <button onClick={() => location.reload()}>Try again</button>
      </div>
    );
  return (
    <main className="auth-card">
      <a className="brand" href="/">
        ● FreeOCRapi
      </a>
      <h1>
        {data?.setupRequired
          ? "Set up your OCR gateway"
          : mode === "forgot"
            ? "Reset your password"
            : mode === "reset"
              ? "Enter reset code"
              : "Welcome back"}
      </h1>
      <p>
        {data?.setupRequired
          ? "Create the local account that protects your provider credentials."
          : mode === "forgot"
            ? "The reset code will appear in the server console."
            : "One API for all your OCR engines."}
      </p>
      <form onSubmit={submit}>
        {mode === "login" && (
          <label>
            Email
            <input
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
        )}
        {mode !== "forgot" && (
          <label>
            Password
            <input
              type="password"
              minLength={data?.setupRequired || mode === "reset" ? 12 : 1}
              maxLength={256}
              required
              autoComplete={
                data?.setupRequired || mode === "reset"
                  ? "new-password"
                  : "current-password"
              }
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        )}
        {(data?.setupRequired || mode === "reset") && (
          <label>
            {mode === "reset"
              ? "Reset code"
              : "Remote setup code (only for LAN setup)"}
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required={mode === "reset"}
            />
          </label>
        )}
        <button className="primary" disabled={busy}>
          {busy
            ? "Please wait…"
            : data?.setupRequired
              ? "Create account"
              : mode === "forgot"
                ? "Get reset code"
                : mode === "reset"
                  ? "Set password"
                  : "Sign in"}
        </button>
      </form>
      {!data?.setupRequired && (
        <button
          className="link-button"
          onClick={() => setMode(mode === "login" ? "forgot" : "login")}
        >
          {mode === "login" ? "Forgot password?" : "Back to sign in"}
        </button>
      )}
    </main>
  );
}
