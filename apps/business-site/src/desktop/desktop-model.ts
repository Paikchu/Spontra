/** The pure decisions of the desktop app's boot script. */

const LOGO = /^https:\/\/images\.financialmodelingprep\.com\/symbol\/([A-Z0-9.%-]{1,24}\.png)$/;

/** Where a request goes in the app: site reads and the stage through the local proxy, everything else untouched. */
export function proxiedUrl(url: string, proxy: string): string {
  if (url.startsWith("/api/") || url.startsWith("/agents/")) return proxy + url;
  const logo = LOGO.exec(url);
  return logo ? `${proxy}/logo/${logo[1]}` : url;
}

export const proxyBase = (userAgent: string) => /Windows/.test(userAgent) ? "http://spontra-api.localhost" : "spontra-api://localhost";

/** The page worth reopening at launch: home or a company, with its view. */
export function isReopenable(path: string): boolean {
  return /^\/(?:companies\/[A-Z][A-Z0-9.-]{0,11}(?:\?[^#]*)?)?$/.test(path);
}

export type Theme = "light" | "dark";

/** At launch the app follows the system, unless the reader chose otherwise the last time it was seen. */
export function themeAtLaunch(saved: string | null, lastSystem: string | null, system: Theme): Theme {
  if (saved !== "light" && saved !== "dark") return system;
  return saved === lastSystem || lastSystem === null ? system : saved;
}

const VIEW_ORDER = ["valuation", "profit", "cash", "balance"] as const;
export type ViewName = (typeof VIEW_ORDER)[number];

/** The view a ⌘ or Ctrl digit asks for. */
export function viewForDigit(key: string): ViewName | null {
  return /^[1-4]$/.test(key) ? VIEW_ORDER[Number(key) - 1]! : null;
}

/** An address the system browser should open instead of the app's own window. */
export function isExternal(href: string): boolean {
  return /^https?:\/\//i.test(href) && !/^https?:\/\/(?:tauri\.)?localhost(?:[:/]|$)/i.test(href);
}

/** The company a link points at, for reading it ahead of the click. */
export function companyOfLink(href: string): string | null {
  return /^\/companies\/([A-Z][A-Z0-9.-]{0,11})(?:[?#]|$)/.exec(href)?.[1] ?? null;
}

const THUMB_WIDTH = 5, THUMB_INSET = 3, THUMB_MIN_HEIGHT = 28;

/** Where the scrolling element's thumb goes, in viewport pixels; nothing when the element does not overflow. */
export function thumbBox(view: { top: number; right: number; height: number }, scrollTop: number, scrollHeight: number): { top: number; left: number; height: number } | null {
  if (scrollHeight <= view.height + 1) return null;
  const track = view.height - THUMB_INSET * 2;
  const height = Math.max(THUMB_MIN_HEIGHT, track * view.height / scrollHeight);
  const travel = Math.min(1, Math.max(0, scrollTop / (scrollHeight - view.height)));
  return { top: view.top + THUMB_INSET + (track - height) * travel, left: view.right - THUMB_WIDTH - THUMB_INSET, height };
}
