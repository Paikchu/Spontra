/**
 * Minimal rich-text parser for model-written prose.
 *
 * The Pipeline stores narrative as plain text and the report page rendered one paragraph per line,
 * so prose that arrived with light markup reached the reader as literal asterisks. This parses the
 * small subset the analysis prompt can produce and leaves everything else as text: plain prose
 * still renders exactly one paragraph per line, as before.
 *
 * The output is an AST, never an HTML string. The renderer builds React elements from it, so model
 * text cannot introduce markup no matter what the model writes.
 */

export type InlineNode =
  | { type: "text"; value: string }
  | { type: "strong"; value: string }
  | { type: "code"; value: string }
  | { type: "link"; value: string; href: string };

export type BlockNode =
  | { type: "paragraph"; inline: InlineNode[] }
  | { type: "heading"; level: 3 | 4; inline: InlineNode[] }
  | { type: "list"; ordered: boolean; items: InlineNode[][] };

const HEADING = /^(#{3,4})\s+(.+)$/;
const BULLET = /^[-*•]\s+(.+)$/;
/** Two digits at most, so a line opening with a year ("2026. 全年指引…") stays a paragraph. */
const ORDERED = /^\d{1,2}[.)]\s+(.+)$/;

/**
 * Every newline ends a block, matching how the page has always split this prose. A blank line adds
 * nothing beyond that, and consecutive list lines merge into one list.
 */
export function parseRichText(source: string): BlockNode[] {
  const blocks: BlockNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flushList = () => {
    if (!list) return;
    blocks.push({ type: "list", ordered: list.ordered, items: list.items.map(parseInline) });
    list = null;
  };
  for (const raw of String(source ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) { flushList(); continue; }
    const heading = HEADING.exec(line);
    if (heading) {
      flushList();
      blocks.push({ type: "heading", level: heading[1]!.length === 3 ? 3 : 4, inline: parseInline(heading[2]!) });
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    const item = bullet?.[1] ?? ordered?.[1];
    if (item !== undefined) {
      const isOrdered = Boolean(ordered);
      if (list && list.ordered !== isOrdered) flushList();
      list ??= { ordered: isOrdered, items: [] };
      list.items.push(item);
      continue;
    }
    flushList();
    blocks.push({ type: "paragraph", inline: parseInline(line) });
  }
  flushList();
  return blocks;
}

/**
 * One pass over the line so a marker cannot be rewritten inside another one's span. Bold uses a
 * lazy `**…**` rather than CommonMark's flanking rules, which need whitespace or punctuation around
 * the marker and therefore miss Chinese prose, where `营收**同比 +18%**增长` has no word boundary.
 *
 * Emphasis by underscore or single asterisk is deliberately absent: metric keys carry underscores
 * (`non_gaap_eps`) and footnote asterisks are literal in filing prose.
 */
export function parseInline(source: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let cursor = 0;
  // An unterminated marker matches nothing and survives as text, so prose truncated mid-`**` by the
  // Pipeline's length cap degrades to plain text instead of swallowing the rest of the line.
  for (const match of source.matchAll(/\*\*(.+?)\*\*|`([^`]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)/g)) {
    const index = match.index;
    if (index > cursor) nodes.push({ type: "text", value: source.slice(cursor, index) });
    if (match[1] !== undefined) nodes.push({ type: "strong", value: match[1] });
    else if (match[2] !== undefined) nodes.push({ type: "code", value: match[2] });
    else {
      const href = safeHref(match[4]!);
      nodes.push(href ? { type: "link", value: match[3]!, href } : { type: "text", value: match[0] });
    }
    cursor = index + match[0].length;
  }
  if (cursor < source.length) nodes.push({ type: "text", value: source.slice(cursor) });
  return nodes;
}

/** Only https and same-site paths become links; anything else stays visible as the text it was. */
function safeHref(value: string): string | null {
  if (/^https:\/\/[^\s]+$/i.test(value)) return value;
  if (/^\/[^/\s][^\s]*$/.test(value)) return value;
  return null;
}
