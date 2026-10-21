import { LENS_HTML_SCRIPT_HOSTS } from "../../analysis-contract/lens.ts";

/** Tags the frame supplies itself, or that would leave the frame or post somewhere. */
const FORBIDDEN_TAGS = ["!doctype", "html", "head", "body", "iframe", "frame", "object", "embed", "form", "base", "meta", "link"] as const;
/** Calls that reach the network or the page around the frame; the frame's sandbox and CSP refuse them anyway. */
const FORBIDDEN_CALLS: Array<[RegExp, string]> = [
  [/\bfetch\s*\(/, "fetch"], [/\bXMLHttpRequest\b/, "XMLHttpRequest"], [/\bWebSocket\b/, "WebSocket"], [/\bEventSource\b/, "EventSource"],
  [/\bsendBeacon\b/, "sendBeacon"], [/\b(?:window\.)?(?:parent|top)\s*\./, "parent/top"], [/\b(?:localStorage|sessionStorage|indexedDB)\b/, "storage"], [/\bdocument\.cookie\b/, "document.cookie"],
];

/**
 * What stops a picture from showing as written: a whole document where a fragment belongs, a script from a
 * host the frame does not allow, or a call the frame refuses. The figures are not checked.
 */
export function htmlProblems(html: string): string[] {
  const out: string[] = [];
  for (const tag of FORBIDDEN_TAGS) if (new RegExp(`<${tag}[\\s>/]`, "i").test(html)) out.push(`<${tag}> is not allowed: write a fragment; the frame supplies the document, its fonts and the page's colour variables`);
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']?([^"'\s>]+)/gi)) {
    const src = m[1]!;
    let host: string | null = null;
    try { const url = new URL(src); host = url.protocol === "https:" ? url.hostname : null; } catch { host = null; }
    if (!host || !(LENS_HTML_SCRIPT_HOSTS as readonly string[]).includes(host)) out.push(`script ${src.slice(0, 80)}: scripts load over https from ${LENS_HTML_SCRIPT_HOSTS.join(", ")} only`);
    else if (!/@\d+\.\d+|\/\d+\.\d+\.\d+\//.test(src)) out.push(`script ${src.slice(0, 80)}: pin an exact version`);
  }
  for (const [pattern, name] of FORBIDDEN_CALLS) if (pattern.test(html)) out.push(`${name} is not available in the frame: it has no network, no storage and no access to the page; put the data in the fragment`);
  if (/<img\b[^>]*\bsrc\s*=\s*["']?(?!data:)/i.test(html)) out.push("images load only as data: URLs");
  return out;
}

/** One line for the observation: size and what the fragment brings. */
export function htmlSummary(html: string): string {
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']?([^"'\s>]+)/gi)].map(m => m[1]!);
  const inline = (html.match(/<script\b(?![^>]*\bsrc\s*=)/gi) ?? []).length;
  const svg = (html.match(/<svg\b/gi) ?? []).length;
  return `${html.length} characters; ${svg} inline svg; ${inline} inline script${inline === 1 ? "" : "s"}${scripts.length ? `; loads ${scripts.join(", ")}` : ""}`;
}
