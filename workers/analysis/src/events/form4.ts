import type { InsiderLine, InsiderTransaction, InsiderTransactionCode } from "../../../../shared/analysis-contract/events.ts";

/**
 * Form 4 is filed as an `ownershipDocument` XML. Workers have no DOM, and the document is small
 * and regular, so a tag scanner is enough: every figure sits in `<field><value>…</value></field>`
 * beside an optional footnote reference.
 */

const CODES = new Set<InsiderTransactionCode>(["S", "P", "M", "F", "A", "G", "D", "C", "J", "X", "W", "I", "Z", "L", "U", "O", "E", "H", "K"]);

function blocks(xml: string, name: string): string[] {
  const out: string[] = [];
  const open = new RegExp(`<${name}(?:\\s[^>]*)?>`, "g");
  let match: RegExpExecArray | null;
  while ((match = open.exec(xml))) {
    const start = match.index + match[0].length;
    const end = xml.indexOf(`</${name}>`, start);
    if (end < 0) break;
    out.push(xml.slice(start, end));
    open.lastIndex = end;
  }
  return out;
}

const decode = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'").replace(/\s+/g, " ").trim();

/** The text of the first `<name>` in the fragment, reading through a `<value>` wrapper when there is one. */
function field(xml: string, name: string): string | null {
  const block = blocks(xml, name)[0];
  if (block == null) return null;
  const value = blocks(block, "value")[0];
  const text = decode((value ?? block).replace(/<[^>]+>/g, ""));
  return text || null;
}

const number = (s: string | null) => { if (s == null) return null; const n = Number(s.replace(/[,$\s]/g, "")); return Number.isFinite(n) ? n : null; };
const flag = (s: string | null) => s == null ? null : /^(1|true|yes)$/i.test(s) ? true : /^(0|false|no)$/i.test(s) ? false : null;

function line(xml: string, derivative: boolean): InsiderLine | null {
  const date = field(xml, "transactionDate");
  const code = field(xml, "transactionCode")?.toUpperCase() ?? null;
  const ad = field(xml, "transactionAcquiredDisposedCode")?.toUpperCase();
  const shares = number(field(xml, "transactionShares"));
  if (!date || !code || !CODES.has(code as InsiderTransactionCode) || (ad !== "A" && ad !== "D") || shares == null) return null;
  const ownership = field(xml, "directOrIndirectOwnership")?.toUpperCase() === "I" ? "I" : "D";
  return {
    date: date.slice(0, 10), code: code as InsiderTransactionCode, acquiredDisposed: ad, shares,
    price: number(field(xml, "transactionPricePerShare")), ownedAfter: number(field(xml, "sharesOwnedFollowingTransaction")), ownership, derivative,
  };
}

/** The raw XML sits beside the rendered one EDGAR lists as the primary document (`xslF345X05/form4.xml` → `form4.xml`). */
export function form4XmlUrl(archiveRoot: string, primaryDocument: string): string {
  return `${archiveRoot}/${primaryDocument.replace(/^xsl[^/]*\//i, "")}`;
}

export function parseForm4(xml: string): InsiderTransaction | null {
  if (!/<ownershipDocument/i.test(xml)) return null;
  const owner = blocks(xml, "reportingOwner")[0] ?? "";
  const ownerCik = field(owner, "rptOwnerCik")?.replace(/^0+/, "") ?? null;
  const ownerName = field(owner, "rptOwnerName");
  if (!ownerCik || !ownerName) return null;
  const relationship = blocks(owner, "reportingOwnerRelationship")[0] ?? "";
  const lines = [
    ...blocks(xml, "nonDerivativeTransaction").map(b => line(b, false)),
    ...blocks(xml, "derivativeTransaction").map(b => line(b, true)),
  ].filter((l): l is InsiderLine => l != null).sort((a, b) => a.date.localeCompare(b.date));
  // Sales and purchases are summed over the non-derivative lines of the filing; one 10b5-1 day is often split across prices.
  const sum = (code: InsiderTransactionCode, ad: "A" | "D") => {
    const picked = lines.filter(l => !l.derivative && l.code === code && l.acquiredDisposed === ad);
    const shares = picked.reduce((s, l) => s + l.shares, 0);
    const money = picked.reduce((s, l) => s + l.shares * (l.price ?? 0), 0);
    return shares > 0 ? { shares, money, averagePrice: money / shares } : null;
  };
  const sold = sum("S", "D"), bought = sum("P", "A");
  const exercised = lines.filter(l => !l.derivative && l.code === "M" && l.acquiredDisposed === "A").reduce((s, l) => s + l.shares, 0);
  const direct = lines.filter(l => !l.derivative && l.ownership === "D" && l.ownedAfter != null);
  const heldAfter = direct.length ? direct[direct.length - 1].ownedAfter : lines.find(l => !l.derivative && l.ownedAfter != null)?.ownedAfter ?? null;
  const footnotes = blocks(xml, "footnote").map(f => decode(f.replace(/<[^>]+>/g, ""))).filter(Boolean).slice(0, 40);
  const adopted = footnotes.map(f => /adopted\s+(?:on\s+)?([A-Z][a-z]+ \d{1,2}, \d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})/.exec(f)?.[1]).find(Boolean) ?? null;
  const planFlag = flag(field(xml, "aff10b5One"));
  return {
    ownerCik, ownerName, title: field(relationship, "officerTitle"),
    isDirector: flag(field(relationship, "isDirector")) === true, isOfficer: flag(field(relationship, "isOfficer")) === true, isTenPercentOwner: flag(field(relationship, "isTenPercentOwner")) === true,
    // Before the 2023 form change there was no box; a footnote naming a 10b5-1 plan still counts.
    rule10b51: planFlag ?? (footnotes.some(f => /10b5-1/i.test(f)) ? true : null),
    planAdoptedOn: adopted ? isoDate(adopted) : null,
    securityTitle: field(blocks(xml, "nonDerivativeTransaction")[0] ?? xml, "securityTitle") ?? "Common Stock",
    lines, sold: sold && { shares: sold.shares, proceeds: sold.money, averagePrice: sold.averagePrice }, bought: bought && { shares: bought.shares, cost: bought.money, averagePrice: bought.averagePrice },
    exercised, heldAfter, footnotes,
  };
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
function isoDate(text: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  const long = /^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/.exec(text);
  if (!long) return null;
  const month = MONTHS.indexOf(long[1].toLowerCase());
  return month < 0 ? null : `${long[3]}-${String(month + 1).padStart(2, "0")}-${long[2].padStart(2, "0")}`;
}
