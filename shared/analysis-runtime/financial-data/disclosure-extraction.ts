/**
 * Loss-aware Inline XBRL inventory. This is a fact collector, not a taxonomy
 * validator, presentation-linkbase interpreter, or a claim that every number in
 * an SEC filing has been structured. Persist the source HTML alongside this data.
 */
export const DISCLOSURE_EXTRACTION_VERSION = "sec-inline-xbrl.v1" as const;

export interface DisclosureSource {
  ticker: string;
  accessionNumber: string;
  documentUrl: string;
  form: string;
  reportDate: string;
  filedAt: string;
}

export interface DisclosureLocator {
  /** Offsets are JavaScript UTF-16 string offsets into the exact input HTML. */
  start: number;
  end: number;
  elementId: string | null;
}

export interface DisclosureIssue { code: string; detail: string }
export interface DisclosureQName { name: string; namespaceUri: string | null }
export interface DisclosureDimension {
  kind: "explicit" | "typed";
  axis: DisclosureQName;
  member: DisclosureQName | null;
  value: string;
  rawHtml: string;
}
export interface DisclosureContext {
  id: string | null;
  entity: { identifier: string; scheme: string | null } | null;
  period: { kind: "instant" | "duration" | "forever" | "unknown"; start: string | null; end: string | null };
  dimensions: DisclosureDimension[];
  rawHtml: string;
  locator: DisclosureLocator;
  issues: DisclosureIssue[];
}
export interface DisclosureUnit {
  id: string | null;
  numerator: DisclosureQName[];
  denominator: DisclosureQName[];
  rawHtml: string;
  locator: DisclosureLocator;
  issues: DisclosureIssue[];
}
export interface DisclosureFact {
  id: string;
  concept: DisclosureQName;
  taxonomy: "standard" | "custom" | "unknown";
  kind: "numeric" | "text" | "fraction" | "unsupported";
  classification: "unclassified";
  contextRef: string | null;
  context: DisclosureContext | null;
  unitRef: string | null;
  unit: DisclosureUnit | null;
  rawValue: string;
  rawHtml: string;
  /** Exact decimal/string; never coerced to IEEE-754 or inferred from a label. */
  normalizedValue: string | null;
  numericValue: string | null;
  fraction: { numerator: string | null; denominator: string | null } | null;
  format: DisclosureQName | null;
  scale: string | null;
  sign: string | null;
  decimals: string | null;
  precision: string | null;
  nil: boolean;
  language: string | null;
  hidden: boolean;
  status: "parsed" | "nil" | "unsupported";
  attributes: Record<string, string>;
  source: DisclosureSource & { locator: DisclosureLocator; continuations: DisclosureLocator[] };
  issues: DisclosureIssue[];
}
export interface FilingDisclosures {
  version: typeof DISCLOSURE_EXTRACTION_VERSION;
  source: DisclosureSource;
  facts: DisclosureFact[];
  contexts: DisclosureContext[];
  units: DisclosureUnit[];
  footnotes: { id: string | null; text: string; rawHtml: string; locator: DisclosureLocator; continuations: DisclosureLocator[]; issues: DisclosureIssue[] }[];
  relationships: { attributes: Record<string, string>; rawHtml: string; locator: DisclosureLocator }[];
  documentText: string;
  coverage: {
    scope: "single_document_inline_xbrl_inventory";
    encountered: number;
    retained: number;
    parsed: number;
    nil: number;
    unsupported: number;
    numeric: number;
    text: number;
    fractions: number;
    standard: number;
    custom: number;
    unknownTaxonomy: number;
    dimensional: number;
    typedDimensional: number;
    contexts: number;
    units: number;
    continuations: number;
    resolvedContinuations: number;
    footnotes: number;
    relationships: number;
    tables: number;
    paragraphs: number;
    documentTextCharacters: number;
    issueCounts: Record<string, number>;
    issues: DisclosureIssue[];
    checklist: { area: string; status: "retained" | "partial" | "not_classified" | "not_structured"; detail: string }[];
    limitations: string[];
  };
}

const IX_NAMESPACES = new Set(["http://www.xbrl.org/2013/inlineXBRL", "http://www.xbrl.org/2008/inlineXBRL"]);
const XBRLI = "http://www.xbrl.org/2003/instance";
const XBRLDI = "http://xbrl.org/2006/xbrldi";
const XSI = "http://www.w3.org/2001/XMLSchema-instance";
const TRANSFORM_NAMESPACES = new Set([
  "http://www.xbrl.org/inlineXBRL/transformation/2010-04-20",
  "http://www.xbrl.org/inlineXBRL/transformation/2011-07-31",
  "http://www.xbrl.org/inlineXBRL/transformation/2015-02-26",
  "http://www.xbrl.org/inlineXBRL/transformation/2020-02-12",
  "http://www.xbrl.org/inlineXBRL/transformation/2022-02-16",
]);
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const BLOCK_TAGS = new Set(["br", "p", "div", "table", "tr", "td", "th", "li", "h1", "h2", "h3", "h4", "h5", "h6", "hr"]);
export interface Element {
  name: string; local: string; namespaceUri: string | null;
  attributes: Record<string, string>; rawAttributes: Record<string, string>;
  namespaces: Record<string, string>; children: (Element | string)[];
  parent: Element | null; start: number; openingEnd: number; end: number;
  closed: boolean;
}
const issue = (code: string, detail: string): DisclosureIssue => ({ code, detail });
const localName = (name: string) => name.slice(name.indexOf(":") + 1);
const locator = (node: Element): DisclosureLocator => ({ start: node.start, end: node.end, elementId: node.attributes.id ?? null });
const raw = (html: string, node: Element) => html.slice(node.start, node.end);
const isInline = (node: Element) => IX_NAMESPACES.has(node.namespaceUri ?? "") || node.name.toLowerCase().startsWith("ix:");
const isInstance = (node: Element, local: string) => node.local === local && (node.namespaceUri === XBRLI || !node.namespaceUri && /^xbrli:/i.test(node.name));
const isDimension = (node: Element) => node.namespaceUri === XBRLDI || !node.namespaceUri && /^xbrldi:/i.test(node.name);

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", ndash: "–", mdash: "—", minus: "−", hellip: "…", bull: "•", reg: "®", copy: "©", trade: "™", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", thinsp: "\u2009", ensp: "\u2002", emsp: "\u2003" };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z][a-z\d]+);/gi, (match, entity: string) => {
    if (!entity.startsWith("#")) return named[entity] ?? match;
    const hex = entity[1].toLowerCase() === "x";
    const point = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : match;
  });
}

/** Quote-aware markup tokenization, no browser DOM or external entities. */
export function parseMarkup(html: string): { nodes: Element[]; root: Element; issues: DisclosureIssue[] } {
  const root: Element = { name: "", local: "", namespaceUri: null, attributes: {}, rawAttributes: {}, namespaces: {}, children: [], parent: null, start: 0, openingEnd: 0, end: html.length, closed: true };
  const stack = [root];
  const nodes: Element[] = [];
  const issues: DisclosureIssue[] = [];
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/?[A-Za-z_][\w:.-]*(?:\s+(?:[^<>"']|"[^"]*"|'[^']*')*)?\s*\/?\s*>/g;
  let previous = 0;
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(html))) {
    const position = match.index!;
    if (position > previous) stack.at(-1)!.children.push(html.slice(previous, position));
    const token = match[0];
    previous = position + token.length;
    if (token.startsWith("<![CDATA[")) { stack.at(-1)!.children.push(token.slice(9, -3)); continue; }
    if (/^<[!?]/.test(token)) continue;
    const closing = token.startsWith("</");
    const name = token.match(/^<\/?([^\s/>]+)/)![1];
    if (closing) {
      const index = stack.findLastIndex((node) => node.name.toLowerCase() === name.toLowerCase());
      if (index > 0) {
        while (stack.length > index) {
          const node = stack.pop()!;
          node.end = previous;
          node.closed = node.name.toLowerCase() === name.toLowerCase();
        }
      }
      continue;
    }
    const parent = stack.at(-1)!;
    const attributes: Record<string, string> = {};
    const rawAttributes: Record<string, string> = {};
    let namespaces = parent.namespaces;
    for (const a of token.slice(name.length + 1).matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      const value = decodeEntities(a[2] ?? a[3] ?? a[4]);
      attributes[a[1].toLowerCase()] = value;
      rawAttributes[a[1]] = value;
      if (a[1] === "xmlns" || a[1].startsWith("xmlns:")) {
        if (namespaces === parent.namespaces) namespaces = { ...namespaces };
        namespaces[a[1] === "xmlns" ? "" : a[1].slice(6)] = value;
      }
    }
    const prefix = name.includes(":") ? name.split(":")[0] : "";
    const node: Element = { name, local: localName(name).toLowerCase(), namespaceUri: namespaces[prefix] ?? null, attributes, rawAttributes, namespaces, children: [], parent, start: position, openingEnd: previous, end: previous, closed: /\/\s*>$/.test(token) || !prefix && VOID_TAGS.has(name.toLowerCase()) };
    parent.children.push(node);
    nodes.push(node);
    // Script/style content is never markup, even if it contains apparent facts.
    if (["script", "style"].includes(node.local) && !prefix && !node.closed) {
      const endPattern = new RegExp(`<\\/${name}\\s*>`, "gi");
      endPattern.lastIndex = previous;
      const endMatch = endPattern.exec(html);
      const end = endMatch ? endMatch.index + endMatch[0].length : html.length;
      node.children.push(html.slice(previous, endMatch?.index ?? html.length));
      node.end = end;
      node.closed = !!endMatch;
      tokens.lastIndex = end;
      previous = end;
    }
    if (!node.closed) stack.push(node);
  }
  if (previous < html.length) stack.at(-1)!.children.push(html.slice(previous));
  for (const node of stack.slice(1)) node.end = html.length;
  if (/<!(?:DOCTYPE|ENTITY)\b/i.test(html)) issues.push(issue("external_entities_not_resolved", "DTD and entity declarations are not evaluated."));
  return { nodes, root, issues };
}

export function descendants(node: Element): Element[] {
  const result: Element[] = [];
  const pending = [...node.children].reverse();
  while (pending.length) {
    const child = pending.pop()!;
    if (typeof child === "string") continue;
    result.push(child);
    for (let i = child.children.length - 1; i >= 0; i--) pending.push(child.children[i]);
  }
  return result;
}
export function nodeText(node: Element, options: { blocks?: boolean; documentTextMode?: boolean } = {}): string {
  const pending: (Element | string)[] = [node];
  const output: string[] = [];
  while (pending.length) {
    const child = pending.pop()!;
    if (typeof child === "string") { output.push(decodeEntities(child)); continue; }
    if (["script", "style"].includes(child.local) || isInline(child) && (child.local === "exclude" && !options.documentTextMode || options.documentTextMode && child.local === "header")) continue;
    if (options.blocks && BLOCK_TAGS.has(child.local)) { output.push(" "); pending.push(" "); }
    for (let i = child.children.length - 1; i >= 0; i--) pending.push(child.children[i]);
  }
  return output.join("");
}
export const normalizedText = (node: Element) => nodeText(node, { blocks: true }).replace(/\s+/g, " ").trim();
function qname(name: string, node: Element): DisclosureQName {
  const prefix = name.includes(":") ? name.split(":")[0] : "";
  return { name, namespaceUri: node.namespaces[prefix] ?? null };
}
function taxonomy(namespace: string | null): DisclosureFact["taxonomy"] {
  if (!namespace) return "unknown";
  return /^https?:\/\/(?:fasb\.org\/(?:us-gaap|srt)\/|xbrl\.sec\.gov\/(?:dei|ecd|ecd-sub|country|currency|exch|invest|naics|sic|stpr)\/|xbrl\.ifrs\.org\/taxonomy\/)/i.test(namespace) ? "standard" : "custom";
}
function validPeriodDate(value: string): boolean {
  // Date.parse alone normalizes impossible dates, e.g. February 30 to March 2.
  if (!/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)?)?$/.test(value)) return false;
  const midnight = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(midnight.getTime()) && midnight.toISOString().slice(0, 10) === value.slice(0, 10) && Number.isFinite(Date.parse(value));
}
function readContext(node: Element, html: string): DisclosureContext {
  const children = descendants(node);
  const find = (local: string) => children.find((child) => isInstance(child, local));
  const identifier = find("identifier");
  const instant = find("instant");
  const start = find("startdate");
  const end = find("enddate");
  const forever = find("forever");
  const issues: DisclosureIssue[] = [];
  const period: DisclosureContext["period"] = instant ? { kind: "instant", start: null, end: normalizedText(instant) } : start && end ? { kind: "duration", start: normalizedText(start), end: normalizedText(end) } : forever ? { kind: "forever", start: null, end: null } : { kind: "unknown", start: start ? normalizedText(start) : null, end: end ? normalizedText(end) : null };
  if (period.kind === "unknown" || [period.start, period.end].some((date) => date !== null && !validPeriodDate(date)) || period.start && period.end && Date.parse(period.start) > Date.parse(period.end)) issues.push(issue("invalid_period", "Context period is missing or is not a valid ISO date/timestamp; no quarter is inferred."));
  if (!identifier) issues.push(issue("missing_entity", "Context has no entity identifier."));
  const dimensions = children.filter((child) => isDimension(child) && ["explicitmember", "typedmember"].includes(child.local)).map((child): DisclosureDimension => ({
    kind: child.local === "typedmember" ? "typed" : "explicit",
    axis: qname(child.attributes.dimension ?? "", child),
    member: child.local === "explicitmember" ? qname(normalizedText(child), child) : null,
    value: normalizedText(child), rawHtml: raw(html, child),
  }));
  if (dimensions.some((dimension) => !dimension.axis.name || !dimension.axis.namespaceUri || dimension.member && !dimension.member.namespaceUri)) issues.push(issue("unresolved_dimension", "One or more dimension QNames have no namespace binding."));
  if (!node.closed) issues.push(issue("malformed_context", "Context is not properly closed."));
  return { id: node.attributes.id ?? null, entity: identifier ? { identifier: normalizedText(identifier), scheme: identifier.attributes.scheme ?? null } : null, period, dimensions, rawHtml: raw(html, node), locator: locator(node), issues };
}
function readUnit(node: Element, html: string): DisclosureUnit {
  const children = descendants(node);
  const numeratorNode = children.find((child) => isInstance(child, "unitnumerator"));
  const denominatorNode = children.find((child) => isInstance(child, "unitdenominator"));
  const measures = (parent: Element) => descendants(parent).filter((child) => isInstance(child, "measure")).map((child) => qname(normalizedText(child), child));
  const numerator = measures(numeratorNode ?? node);
  const denominator = denominatorNode ? measures(denominatorNode) : [];
  const issues: DisclosureIssue[] = [];
  if (!numerator.length || children.some((child) => isInstance(child, "divide")) && (!numeratorNode || !denominator.length)) issues.push(issue("invalid_unit", "Unit has incomplete numerator or denominator measures."));
  if ([...numerator, ...denominator].some((measure) => !measure.namespaceUri)) issues.push(issue("unresolved_unit", "Unit measure QName has no namespace binding."));
  if (!node.closed) issues.push(issue("malformed_unit", "Unit is not properly closed."));
  return { id: node.attributes.id ?? null, numerator, denominator, rawHtml: raw(html, node), locator: locator(node), issues };
}

/** Decimal shift on strings retains digits beyond Number.MAX_SAFE_INTEGER. */
function scaleDecimal(value: string, scale: number, sign: string | null): string | null {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return null;
  const negative = value.startsWith("-") !== (sign === "-");
  const [integer, fraction = ""] = value.replace(/^[+-]/, "").split(".");
  const digits = (integer || "0") + fraction;
  const point = (integer || "0").length + scale;
  const expanded = point <= 0 ? `0.${"0".repeat(-point)}${digits}` : point >= digits.length ? digits + "0".repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`;
  const [whole, decimal = ""] = expanded.split(".");
  const result = whole.replace(/^0+(?=\d)/, "") + (decimal.replace(/0+$/, "") ? `.${decimal.replace(/0+$/, "")}` : "");
  return negative && result !== "0" ? `-${result}` : result;
}
function transformedValue(value: string, format: DisclosureQName | null, numeric: boolean, issues: DisclosureIssue[]): string | null {
  if (!format) return numeric ? value.trim() : value;
  const name = localName(format.name).toLowerCase();
  if (!TRANSFORM_NAMESPACES.has(format.namespaceUri ?? "")) {
    issues.push(issue("unsupported_transform", `Transformation ${format.name} (${format.namespaceUri ?? "unbound namespace"}) is retained as raw text.`));
    return null;
  }
  const fixed: Record<string, string> = { "fixed-zero": "0", "fixed-empty": "", "fixed-true": "true", "fixed-false": "false", "zerodash": "0", "booleantrue": "true", "booleanfalse": "false" };
  if (Object.hasOwn(fixed, name)) {
    if (name === "zerodash" && !/^[\s\-–—−]+$/.test(value)) { issues.push(issue("invalid_numeric", "zerodash input is not a dash.")); return null; }
    return fixed[name];
  }
  const compact = value.trim();
  if (["num-dot-decimal", "numdotdecimal", "numcommadot", "num-dot-decimal-apos"].includes(name)) {
    const valid = name.endsWith("-apos") ? /^(?:\d+|\d{1,3}(?:[,\s'’]\d{3})+)(?:\.\d*)?$|^\.\d+$/ : /^(?:\d+|\d{1,3}(?:[,\s]\d{3})+)(?:\.\d*)?$|^\.\d+$/;
    if (valid.test(compact)) return compact.replace(/[,\s'’]/g, "");
    issues.push(issue("invalid_numeric", `Invalid non-negative dot-decimal input for ${format.name}.`));
    return null;
  }
  if (["num-comma-decimal", "numcommadecimal", "numdotcomma", "num-comma-decimal-apos"].includes(name)) {
    const valid = name.endsWith("-apos") ? /^(?:\d+|\d{1,3}(?:[.\s'’]\d{3})+)(?:,\d*)?$|^,\d+$/ : /^(?:\d+|\d{1,3}(?:[.\s]\d{3})+)(?:,\d*)?$|^,\d+$/;
    if (valid.test(compact)) return compact.replace(/[.\s'’]/g, "").replace(",", ".");
    issues.push(issue("invalid_numeric", `Invalid non-negative comma-decimal input for ${format.name}.`));
    return null;
  }
  issues.push(issue("unsupported_transform", `Transformation ${format.name} is not implemented; source text is retained.`));
  return null;
}
function numericValue(node: Element, value: string, issues: DisclosureIssue[]): string | null {
  const format = node.attributes.format ? qname(node.attributes.format, node) : null;
  const transformed = transformedValue(value, format, true, issues);
  const scale = node.attributes.scale ?? "0";
  if (!/^[+-]?\d+$/.test(scale) || Math.abs(Number(scale)) > 1000) { issues.push(issue("unsupported_scale", `Scale ${scale} is invalid or exceeds the exact-decimal expansion limit (1000).`)); return null; }
  if (node.attributes.sign !== undefined && node.attributes.sign !== "-") { issues.push(issue("invalid_sign", "Inline XBRL sign must be '-' when supplied.")); return null; }
  if (transformed === null) return null;
  const result = scaleDecimal(transformed, Number(scale), node.attributes.sign ?? null);
  if (result === null) issues.push(issue("invalid_numeric", "Value is not an exact decimal after transformation; no value was guessed."));
  return result;
}

function continuedContent(node: Element, continuationMap: Map<string, Element[]>, html: string): { value: string; rawHtml: string; locators: DisclosureLocator[]; issues: DisclosureIssue[] } {
  const parts = [nodeText(node, { blocks: node.local !== "nonfraction" })];
  const rawParts = [raw(html, node)];
  const locators: DisclosureLocator[] = [];
  const issues: DisclosureIssue[] = [];
  const visited = new Set<string>();
  let next = node.attributes.continuedat;
  while (next) {
    if (visited.has(next)) { issues.push(issue("continuation_cycle", `Continuation ${next} forms a cycle.`)); break; }
    visited.add(next);
    const matches = continuationMap.get(next) ?? [];
    if (matches.length !== 1) { issues.push(issue(matches.length ? "ambiguous_continuation" : "missing_continuation", `Continuation ${next} resolves to ${matches.length} elements.`)); break; }
    const continuation = matches[0];
    parts.push(nodeText(continuation, { blocks: true }));
    rawParts.push(raw(html, continuation));
    locators.push(locator(continuation));
    if (!continuation.closed) issues.push(issue("malformed_continuation", `Continuation ${next} is not properly closed.`));
    next = continuation.attributes.continuedat;
  }
  return { value: parts.join(""), rawHtml: rawParts.join("\n"), locators, issues };
}
function indexById<T extends { id: string | null }>(items: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) if (item.id) map.set(item.id, [...(map.get(item.id) ?? []), item]);
  return map;
}

export function extractFilingDisclosures(html: string, source: DisclosureSource): FilingDisclosures {
  const { nodes, root, issues: documentIssues } = parseMarkup(html);
  const contexts = nodes.filter((node) => isInstance(node, "context")).map((node) => readContext(node, html));
  const units = nodes.filter((node) => isInstance(node, "unit")).map((node) => readUnit(node, html));
  const contextMap = indexById(contexts);
  const unitMap = indexById(units);
  const continuationNodes = nodes.filter((node) => isInline(node) && node.local === "continuation");
  const continuationMap = new Map<string, Element[]>();
  for (const node of continuationNodes) if (node.attributes.id) continuationMap.set(node.attributes.id, [...(continuationMap.get(node.attributes.id) ?? []), node]);
  const factNodes = nodes.filter((node) => isInline(node) && ["nonfraction", "nonnumeric", "fraction", "tuple"].includes(node.local) || node.attributes.contextref !== undefined && (!isInline(node) || node.attributes.name !== undefined));
  const facts = factNodes.map((node): DisclosureFact => {
    const a = node.attributes;
    const content = continuedContent(node, continuationMap, html);
    const issues = [...content.issues];
    const kind = !isInline(node) ? "unsupported" : node.local === "nonfraction" ? "numeric" : node.local === "nonnumeric" ? "text" : node.local === "fraction" ? "fraction" : "unsupported";
    const concept = qname(a.name ?? (kind === "unsupported" ? node.name : ""), node);
    if (!concept.name || !concept.namespaceUri) issues.push(issue("unresolved_concept", "Concept is missing or its namespace is not bound."));
    if (isInline(node) && !IX_NAMESPACES.has(node.namespaceUri ?? "")) issues.push(issue("unsupported_inline_namespace", "Inline tag namespace is missing or not a supported Inline XBRL version."));
    const contextMatches = contextMap.get(a.contextref ?? "") ?? [];
    const context = contextMatches.length === 1 ? contextMatches[0] : null;
    if (!context) issues.push(issue(contextMatches.length ? "ambiguous_context" : "missing_context", `contextRef ${a.contextref ?? "(missing)"} resolves to ${contextMatches.length} contexts.`));
    if (context) issues.push(...context.issues);
    const unitMatches = unitMap.get(a.unitref ?? "") ?? [];
    const unit = unitMatches.length === 1 ? unitMatches[0] : null;
    if (["numeric", "fraction"].includes(kind) && !unit) issues.push(issue(unitMatches.length ? "ambiguous_unit" : "missing_unit", `unitRef ${a.unitref ?? "(missing)"} resolves to ${unitMatches.length} units.`));
    if (unit) issues.push(...unit.issues);
    const nilAttribute = Object.entries(node.rawAttributes).find(([name]) => localName(name) === "nil" && qname(name, node).namespaceUri === XSI)?.[1];
    const nil = nilAttribute === "true" || nilAttribute === "1";
    if (nilAttribute !== undefined && !["true", "false", "1", "0"].includes(nilAttribute)) issues.push(issue("invalid_nil", "xsi:nil is not a valid XML boolean."));
    if (!node.closed) issues.push(issue("malformed_fact", "Fact element is not properly closed."));
    if ([...content.rawHtml.matchAll(/&(?:#x[\da-f]+|#\d+|[a-z][a-z\d]+);/gi)].some(([entity]) => decodeEntities(entity) === entity)) issues.push(issue("unresolved_entity", "An entity remains unresolved; source HTML is retained."));
    if (a.decimals !== undefined && !/^(?:INF|[+-]?\d+)$/.test(a.decimals)) issues.push(issue("invalid_decimals", "decimals is neither an integer nor INF."));
    if (a.precision !== undefined && !/^(?:INF|\d+)$/.test(a.precision)) issues.push(issue("invalid_precision", "precision is neither a non-negative integer nor INF."));
    let normalizedValue: string | null = null;
    let exactNumber: string | null = null;
    let fraction: DisclosureFact["fraction"] = null;
    if (!nil && kind === "numeric") normalizedValue = exactNumber = numericValue(node, content.value, issues);
    if (!nil && kind === "text") normalizedValue = transformedValue(content.value, a.format ? qname(a.format, node) : null, false, issues);
    if (!nil && kind === "fraction") {
      if (a.scale !== undefined || a.sign !== undefined) issues.push(issue("unsupported_fraction_attributes", "Fraction-level scale/sign are retained without interpretation."));
      const children = descendants(node);
      const numerators = children.filter((child) => isInline(child) && child.local === "numerator");
      const denominators = children.filter((child) => isInline(child) && child.local === "denominator");
      fraction = { numerator: numerators.length === 1 ? numericValue(numerators[0], nodeText(numerators[0]), issues) : null, denominator: denominators.length === 1 ? numericValue(denominators[0], nodeText(denominators[0]), issues) : null };
      if (fraction.numerator === null || fraction.denominator === null || fraction.denominator === "0") issues.push(issue("invalid_fraction", "Fraction requires one numeric numerator and one nonzero denominator."));
      else normalizedValue = `${fraction.numerator}/${fraction.denominator}`;
    }
    if (kind === "unsupported") issues.push(issue("unsupported_fact_element", `Element ${node.name} is retained; native XBRL instances and unknown fact elements are not interpreted.`));
    let hidden = false;
    let language: string | null = null;
    for (let ancestor: Element | null = node; ancestor; ancestor = ancestor.parent) {
      if (isInline(ancestor) && ancestor.local === "hidden") hidden = true;
      language ??= ancestor.attributes["xml:lang"] ?? ancestor.attributes.lang ?? null;
    }
    return { id: `${source.accessionNumber}:${encodeURIComponent(source.documentUrl)}:${node.start}`, concept, taxonomy: taxonomy(concept.namespaceUri), kind, classification: "unclassified", contextRef: a.contextref ?? null, context, unitRef: a.unitref ?? null, unit, rawValue: content.value, rawHtml: content.rawHtml, normalizedValue, numericValue: exactNumber, fraction, format: a.format ? qname(a.format, node) : null, scale: a.scale ?? null, sign: a.sign ?? null, decimals: a.decimals ?? null, precision: a.precision ?? null, nil, language, hidden, status: issues.length ? "unsupported" : nil ? "nil" : "parsed", attributes: node.rawAttributes, source: { ...source, locator: locator(node), continuations: content.locators }, issues };
  });
  const footnotes = nodes.filter((node) => isInline(node) && node.local === "footnote").map((node) => {
    const content = continuedContent(node, continuationMap, html);
    return { id: node.attributes.id ?? null, text: content.value, rawHtml: content.rawHtml, locator: locator(node), continuations: content.locators, issues: content.issues };
  });
  const relationships = nodes.filter((node) => isInline(node) && node.local === "relationship").map((node) => ({ attributes: node.rawAttributes, rawHtml: raw(html, node), locator: locator(node) }));
  const usedContinuations = new Set([...facts.flatMap((fact) => fact.source.continuations), ...footnotes.flatMap((footnote) => footnote.continuations)].map((item) => item.start));
  for (const node of continuationNodes) if (!usedContinuations.has(node.start)) documentIssues.push(issue("unreferenced_continuation", `Continuation at offset ${node.start} is not attached to a retained fact or footnote; it remains in documentText and source HTML.`));
  if (!factNodes.length) documentIssues.push(issue("no_inline_facts", "No Inline XBRL facts found. Untagged HTML tables and narrative require a separate parser or review."));
  const documentText = nodeText(root, { blocks: true, documentTextMode: true }).replace(/\s+/g, " ").trim();
  const issueCounts: Record<string, number> = {};
  for (const entry of [...documentIssues, ...facts.flatMap((fact) => fact.issues), ...footnotes.flatMap((footnote) => footnote.issues)]) issueCounts[entry.code] = (issueCounts[entry.code] ?? 0) + 1;
  const count = (predicate: (fact: DisclosureFact) => boolean) => facts.filter(predicate).length;
  return {
    version: DISCLOSURE_EXTRACTION_VERSION, source: { ...source }, facts, contexts, units, footnotes, relationships, documentText,
    coverage: {
      scope: "single_document_inline_xbrl_inventory", encountered: factNodes.length, retained: facts.length,
      parsed: count((fact) => fact.status === "parsed"), nil: count((fact) => fact.status === "nil"), unsupported: count((fact) => fact.status === "unsupported"),
      numeric: count((fact) => fact.kind === "numeric"), text: count((fact) => fact.kind === "text"), fractions: count((fact) => fact.kind === "fraction"),
      standard: count((fact) => fact.taxonomy === "standard"), custom: count((fact) => fact.taxonomy === "custom"), unknownTaxonomy: count((fact) => fact.taxonomy === "unknown"),
      dimensional: count((fact) => !!fact.context?.dimensions.length), typedDimensional: count((fact) => !!fact.context?.dimensions.some((dimension) => dimension.kind === "typed")),
      contexts: contexts.length, units: units.length, continuations: continuationNodes.length, resolvedContinuations: usedContinuations.size, footnotes: footnotes.length, relationships: relationships.length,
      tables: nodes.filter((node) => node.local === "table").length, paragraphs: nodes.filter((node) => node.local === "p").length, documentTextCharacters: documentText.length, issueCounts, issues: documentIssues,
      checklist: [
        { area: "income_statement", status: "not_classified", detail: "All tagged facts are retained, across all disclosed periods; presentation linkbases are not loaded." },
        { area: "balance_sheet", status: "not_classified", detail: "Instant contexts are retained; statement membership is not inferred from concept names." },
        { area: "cash_flow", status: "not_classified", detail: "Duration start/end dates are retained. Annual and year-to-date facts are never relabeled as quarters." },
        { area: "segments", status: "partial", detail: "All explicit/typed dimension data is retained. Dimensions are not assumed to represent business segments." },
        { area: "notes", status: "partial", detail: "Tagged text, continuations, footnotes and relationships are retained; untagged narrative remains document text." },
        { area: "company_custom_metrics", status: "partial", detail: "Custom taxonomy facts are retained; untagged company KPIs are not inferred." },
        { area: "units_periods_sources", status: "retained", detail: "Every fact retains attributes, context, units, raw HTML and source offsets; invalid references are explicit issues." },
        { area: "non_xbrl_tables_and_narrative", status: "not_structured", detail: "Document text and source URL are retained. Text/PDF/image tables require dedicated extraction and review." },
      ],
      limitations: [
        "Inventory covers this supplied HTML document only, not all exhibits, filings, PDFs, images or externally linked documents.",
        "No presentation/calculation/definition linkbase or taxonomy schema validation; all statement classifications remain unclassified.",
        "Only explicitly implemented XBRL numeric/fixed transformations are normalized; other transformations retain raw values and unsupported_transform issues.",
        "Text blocks retain source HTML; normalized text is a readable rendering, not a validated escaped XHTML XBRL value.",
        "Untagged narrative, tables and custom KPIs are not fully structured. Coverage counts describe tagged facts, not all financial information.",
        "No currency conversion, unit conversion, imputed zeroes, annual-to-quarter conversion, duplicate removal or conflicting-fact selection.",
        "External entities/DTDs are not expanded. Offsets require retaining the exact source HTML; source locators must not be rendered as trusted HTML.",
      ],
    },
  };
}
