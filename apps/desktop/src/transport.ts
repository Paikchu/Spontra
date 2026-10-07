import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { configureClientPlatform, type ApiFetch } from "@/packages/client/src/platform";
export const API_ORIGIN = "https://spontra-app.max-zhangyuchen.workers.dev";
export const AUTH_EVENT = "spontra:unauthorized";
type NativeResponse = { status: number; body: string };
export const desktopFetch: ApiFetch = async (path, init = {}) => {
  if (!path.startsWith("/api/") || path.includes("\\") || path.includes("#")) throw new Error("不支持的请求地址。");
  const signal = init.signal;
  signal?.throwIfAborted();
  const id = crypto.randomUUID();
  let abort: () => void = () => {};
  const canceled = new Promise<never>((_, reject) => {
    abort = () => {
      void invoke("cancel_request", { id }).catch(() => {});
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
  try {
    const result = await Promise.race([invoke<NativeResponse>("api_request", {
      id, path: path.slice(4), method: init.method ?? "GET", body: typeof init.body === "string" ? init.body : null,
    }), canceled]);
    signal?.throwIfAborted();
    if (result.status === 401) window.dispatchEvent(new Event(AUTH_EVENT));
    return new Response(result.body, { status: result.status, headers: { "content-type": "application/json" } });
  } catch (error) {
    if (error instanceof DOMException) throw error;
    if (String(error).includes("AUTH_REQUIRED")) window.dispatchEvent(new Event(AUTH_EVENT));
    throw new Error("连接暂时不可用，请检查网络后重试。");
  } finally { signal?.removeEventListener("abort", abort); }
};
export function initializePlatform() {
  configureClientPlatform({ fetch: desktopFetch, publicOrigin: () => API_ORIGIN, copyText: writeText, persistQuotes: false, kind: "desktop" });
}
export const connect = (token: string) => invoke<void>("connect", { token });
export const disconnect = () => invoke<void>("disconnect");
export const connectionStatus = () => invoke<boolean>("connection_status");
export const openExternal = (url: string) => invoke<void>("open_external", { url });
