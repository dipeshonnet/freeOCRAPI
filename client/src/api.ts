export const token = () => localStorage.getItem("freeocrapi.session") || "";
export function saveToken(value: string) {
  localStorage.setItem("freeocrapi.session", value);
  window.dispatchEvent(new Event("auth-change"));
}
export function logout() {
  localStorage.removeItem("freeocrapi.session");
  window.dispatchEvent(new Event("auth-change"));
}
export function notify(message: string) {
  window.dispatchEvent(new CustomEvent("notice", { detail: message }));
}
export async function response(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (token()) headers.set("Authorization", `Bearer ${token()}`);
  if (
    init.body &&
    !(init.body instanceof FormData) &&
    !headers.has("Content-Type")
  )
    headers.set("Content-Type", "application/json");
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      message = data.error?.message || message;
    } catch {}
    if (res.status === 401 && token()) logout();
    throw new Error(message);
  }
  return res;
}
export async function api<T = unknown>(
  url: string,
  init: RequestInit = {},
): Promise<T> {
  return (await response(url, init)).json();
}
export const put = (url: string, data: unknown) =>
  api(url, { method: "PUT", body: JSON.stringify(data) });
export const post = <T = unknown>(url: string, data: unknown = {}) =>
  api<T>(url, { method: "POST", body: JSON.stringify(data) });
export async function download(url: string, filename: string) {
  const blob = await (await response(url)).blob();
  const link = document.createElement("a");
  const objectUrl = URL.createObjectURL(blob);
  link.href = objectUrl;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
