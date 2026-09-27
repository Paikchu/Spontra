/** Client runtime boundary. Server rendering always uses the browser defaults. */
export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;
export interface ClientPlatform {
  fetch: ApiFetch;
  publicOrigin: () => string;
  copyText: (text: string) => Promise<void>;
  persistQuotes: boolean;
  kind: "web" | "desktop";
}
const browser: ClientPlatform = {
  fetch: (path, init) => fetch(path, init),
  publicOrigin: () => typeof window === "undefined" ? "" : window.location.origin,
  copyText: (text) => navigator.clipboard.writeText(text),
  persistQuotes: true,
  kind: "web",
};
let platform = browser;
/** Called once by the desktop entry point, never by server request handlers. */
export function configureClientPlatform(value: ClientPlatform) { platform = value; }
export const apiFetch: ApiFetch = (path, init) => platform.fetch(path, init);
export const publicOrigin = () => platform.publicOrigin();
export const copyText = (text: string) => platform.copyText(text);
export const platformKind = () => platform.kind;
export const persistQuotes = () => platform.persistQuotes;
export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, init);
  if (!response.ok) throw new Error(response.status === 404 ? "未找到对应内容。" : "数据暂时无法读取，请重试。");
  return response.json() as Promise<T>;
}
