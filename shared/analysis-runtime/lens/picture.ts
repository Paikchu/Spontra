import { LENS_ASPECT, type LensAspect } from "../../analysis-contract/lens.ts";
import type { LensFrameTheme } from "../../analysis-contract/lens-frame.ts";

/**
 * The document an html picture runs in, built the same way by the page's frame (`public/html-frame.html`, which
 * holds a copy of these strings; a test keeps them equal) and by the harness's browser that measures the picture
 * for the agent. Pure strings: no DOM.
 */

/** The frame's own policy, as `_headers` serves it for `/html-frame`; the harness applies it as a meta tag. */
export const PICTURE_CSP = "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; style-src 'unsafe-inline'; img-src data: blob:; font-src https: data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";

/**
 * Paper, type and SVG defaults under every fragment. The body is a column exactly the frame's height: a fragment
 * puts its title and subtitle first and gives the drawing the rest (`flex:1; min-height:0`); nothing scrolls.
 */
export const PICTURE_BASE_CSS = "html,body{margin:0;padding:0;height:100%;background:transparent;overflow:hidden}body{display:flex;flex-direction:column;color:var(--foreground);font-family:var(--sans,system-ui,sans-serif);font-size:13px;line-height:1.5;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}svg{display:block;max-width:100%;overflow:visible}";

/** The page's dark theme, the one the harness measures in: the values of `apps/business-site/src/style.css` `:root` (a test keeps them equal). */
export const PICTURE_PREVIEW_THEME: LensFrameTheme = { scheme: "dark", tokens: {
  "--background": "#0a1412", "--surface": "#0f1d1a", "--border": "#20352f", "--hairline": "#ffffff0f", "--foreground": "#e8efeb",
  "--muted-foreground": "#93a59d", "--faint": "#66796f", "--up": "#79d9cd", "--loss": "#f08e83", "--flow-revenue": "#d9e4de",
  "--flow-profit": "#79d9cd", "--flow-expense": "#e8b777", "--biz-0": "#7d8f88", "--biz-1": "#4489e0", "--biz-2": "#d2578c",
  "--biz-3": "#8a7ae8", "--biz-4": "#2ea6b8", "--sans": "\"Geist\", \"PingFang SC\", \"Noto Sans SC\", \"Microsoft YaHei\", system-ui, sans-serif",
  "--ease": "cubic-bezier(.22, 1, .36, 1)",
} };

/** Room for a picture's title and subtitle above its drawing. */
export const PICTURE_HEAD = 72;
/** The tallest and shortest a picture's frame gets, whatever its width. */
export const PICTURE_MAX = 520, PICTURE_MIN = 240;
/**
 * The frame's height at a width: the drawing's aspect over the width plus room for the title, kept between the
 * bounds. The page sets the same rule in CSS (`.lens-html-cell`, which also stays under 62vh); the harness draws
 * at this height and the audit balances rows with it.
 */
export const pictureHeight = (width: number, aspect: LensAspect) => Math.round(Math.min(PICTURE_MAX, Math.max(PICTURE_MIN, width * LENS_ASPECT[aspect] + PICTURE_HEAD)));

export const pictureVars = (theme: LensFrameTheme) => `:root{${Object.entries(theme.tokens).map(([k, v]) => `${k}:${v}`).join(";")};color-scheme:${theme.scheme}}`;

/** The whole document for one fragment, as the harness's browser loads it: the frame's policy, the page's tokens, the fragment. */
export function pictureDocument(html: string, theme: LensFrameTheme = PICTURE_PREVIEW_THEME, lang = "en"): string {
  return `<!doctype html><html lang="${lang.replace(/[^a-zA-Z-]/g, "")}" class="${theme.scheme}"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${PICTURE_CSP.replace("frame-ancestors 'self'; ", "")}"><meta name="viewport" content="width=device-width, initial-scale=1"><style id="tokens">${pictureVars(theme)}</style><style>${PICTURE_BASE_CSS}</style></head><body>${html}</body></html>`;
}

/** A short, stable name for a fragment: FNV-1a over its text. */
export function pictureHash(html: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < html.length; i++) { h ^= html.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
