import type { StatementCell, StatementTable } from "../../../shared/analysis-runtime/financial-data/financial-statements";

export type StatementCategory = "balance" | "income" | "cashflow" | "other" | "notes";
export const STATEMENT_CATEGORY_LABELS: Record<StatementCategory, string> = {
  balance: "资产负债表", income: "利润表", cashflow: "现金流量表", other: "其他报表", notes: "附注",
};

/** Navigation follows the source's explicit headings, not the concepts or numbers in a table. */
export function classifyStatementCategory(section: string): StatementCategory {
  const heading = section.trim().replace(/\s+/g, " ");
  if (/^(?:notes?\b|\d{1,2}[.\s:–—-]+\D)/i.test(heading)) return "notes";
  if (/\bbalance sheets?\b|\bstatements? of financial (?:position|condition)\b/i.test(heading)) return "balance";
  if (/\b(?:comprehensive (?:income|loss)|(?:stockholders|shareholders|owners)[’']? equity|changes in equity)\b/i.test(heading)) return "other";
  if (/\bcash flows?\b/i.test(heading)) return "cashflow";
  if (/\bstatements? of (?:income|operations|earnings|profit or loss)\b|\b(?:income|operations|earnings) statements?\b/i.test(heading)) return "income";
  return "other";
}

const LABELS: Record<string, string> = {
  "balance sheets": "资产负债表",
  "statements of financial position": "财务状况表",
  "statements of financial condition": "财务状况表",
  "statements of operations": "利润表",
  "statements of income": "利润表",
  "statements of earnings": "利润表",
  "statements of comprehensive income": "综合收益表",
  "statements of comprehensive loss": "综合损益表",
  "statements of cash flows": "现金流量表",
  "statements of stockholders' equity": "股东权益变动表",
  "statements of shareholders' equity": "股东权益变动表",
  "assets": "资产",
  "current assets": "流动资产",
  "cash and cash equivalents": "现金及现金等价物",
  "cash, cash equivalents and restricted cash": "现金、现金等价物及受限现金",
  "marketable securities": "有价证券",
  "short-term investments": "短期投资",
  "accounts receivable": "应收账款",
  "accounts receivable, net": "应收账款净额",
  "inventories": "存货",
  "inventory": "存货",
  "prepaid expenses and other current assets": "预付费用及其他流动资产",
  "other current assets": "其他流动资产",
  "total current assets": "流动资产合计",
  "property, plant and equipment, net": "不动产、厂房及设备净额",
  "property and equipment, net": "固定资产净额",
  "operating lease right-of-use assets": "经营租赁使用权资产",
  "intangible assets, net": "无形资产净额",
  "goodwill": "商誉",
  "deferred tax assets": "递延所得税资产",
  "other non-current assets": "其他非流动资产",
  "other noncurrent assets": "其他非流动资产",
  "total assets": "资产总计",
  "liabilities": "负债",
  "current liabilities": "流动负债",
  "accounts payable": "应付账款",
  "accrued expenses": "应计费用",
  "deferred revenues": "递延收入",
  "deferred revenue": "递延收入",
  "short-term debt": "短期债务",
  "current portion of long-term debt": "长期债务当期到期部分",
  "other current liabilities": "其他流动负债",
  "total current liabilities": "流动负债合计",
  "long-term debt": "长期债务",
  "long-term debt, net": "长期债务净额",
  "deferred tax liabilities": "递延所得税负债",
  "other non-current liabilities": "其他非流动负债",
  "other noncurrent liabilities": "其他非流动负债",
  "total liabilities": "负债合计",
  "commitments and contingencies": "承诺及或有事项",
  "stockholders' equity": "股东权益",
  "shareholders' equity": "股东权益",
  "common stock": "普通股",
  "additional paid-in capital": "额外实收资本",
  "retained earnings": "留存收益",
  "accumulated deficit": "累计亏损",
  "accumulated other comprehensive income": "累计其他综合收益",
  "accumulated other comprehensive loss": "累计其他综合损失",
  "treasury stock": "库存股",
  "total stockholders' equity": "股东权益合计",
  "total shareholders' equity": "股东权益合计",
  "total liabilities and stockholders' equity": "负债及股东权益总计",
  "total liabilities and shareholders' equity": "负债及股东权益总计",
  "revenue": "收入",
  "revenues": "收入",
  "total revenues": "收入合计",
  "cloud": "云服务",
  "software": "软件",
  "hardware": "硬件",
  "services": "服务",
  "cloud and software": "云服务及软件",
  "net sales": "销售净额",
  "cost of revenues": "收入成本",
  "cost of revenue": "收入成本",
  "cost of sales": "销售成本",
  "gross profit": "毛利润",
  "research and development": "研发费用",
  "sales and marketing": "销售及营销费用",
  "general and administrative": "一般及行政费用",
  "selling, general and administrative": "销售、一般及行政费用",
  "operating expenses": "营业费用",
  "total operating expenses": "营业费用合计",
  "operating income": "营业利润",
  "operating income (loss)": "营业利润（亏损）",
  "income from operations": "营业利润",
  "interest expense": "利息费用",
  "interest income": "利息收入",
  "income before income taxes": "税前利润",
  "provision for income taxes": "所得税费用",
  "income tax expense": "所得税费用",
  "net income": "净利润",
  "net income (loss)": "净利润（亏损）",
  "net loss": "净亏损",
  "earnings per share": "每股收益",
  "basic": "基本",
  "diluted": "稀释",
  "cash flows from operating activities": "经营活动现金流量",
  "cash flows from investing activities": "投资活动现金流量",
  "cash flows from financing activities": "融资活动现金流量",
  "net cash provided by operating activities": "经营活动产生的现金净额",
  "net cash used in operating activities": "经营活动使用的现金净额",
  "net cash provided by investing activities": "投资活动产生的现金净额",
  "net cash used in investing activities": "投资活动使用的现金净额",
  "net cash provided by financing activities": "融资活动产生的现金净额",
  "net cash used in financing activities": "融资活动使用的现金净额",
  "depreciation and amortization": "折旧及摊销",
  "stock-based compensation": "股份支付费用",
  "share-based compensation": "股份支付费用",
  "capital expenditures": "资本支出",
  "dividends paid": "已支付股利",
  "repurchases of common stock": "普通股回购",
};

/** A display alias only: unknown labels, dates, numeric text and original footnotes remain intact. */
export function translateStatementLabel(text: string): string {
  const trimmed = text.trim();
  const suffix = trimmed.match(/(\s*\(\d+(?:\s*,\s*\d+)*\))?\s*[:：]?$/)?.[0] ?? "";
  let key = trimmed.slice(0, trimmed.length - suffix.length).toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ");
  key = key.replace(/^(?:(?:condensed|consolidated|combined)\s+)+(?=(?:balance sheets|statements of)\b)/, "");
  return LABELS[key] ? LABELS[key] + suffix : text;
}

export function statementRowText(row: StatementTable["rows"][number]): string {
  return row.cells.map(cell => cell.text).join(" ").replace(/\s+/g, " ").trim();
}

export type StatementColumnKind = "label" | "data" | "decoration" | "empty";
export type StatementColumnLayout = { index: number; kind: StatementColumnKind };
const decoration = (text: string) => /^(?:[$€£¥₹%()]|US\$|C\$|A\$)$/.test(text.trim());
const numericText = (text: string) => /^[+\-−]?(?:\(?\s*[$€£¥]?\s*)?\d[\d,.\s]*(?:%|\))?$/.test(text.trim());
const numericFact = (cell: StatementCell) => cell.facts.some(fact => fact.value !== null && /^[+\-]?\d+(?:\.\d+)?$/.test(fact.value));

/** Width hints for a colgroup, never a rewrite. Currency/sign/spacer cells and every span stay
 * in the rendered table. A dash is data; it must never be mistaken for an empty spacer. */
export function statementColumnLayout(table: StatementTable): StatementColumnLayout[] {
  const count = Math.max(table.columns, ...table.rows.flatMap(row => row.cells.map(cell => cell.column + cell.colSpan)), 0);
  const evidence = Array.from({ length: count }, () => ({ data: false, decoration: false, text: false, label: false }));
  for (const row of table.rows) {
    const firstContent = row.cells.find(cell => cell.text.trim() && !decoration(cell.text));
    for (const cell of row.cells) {
      const text = cell.text.trim();
      const number = numericFact(cell) || numericText(text) || /^[—–-]$/.test(text);
      const label = cell === firstContent && !!text && !number && !decoration(text);
      if (label) evidence[cell.column].label = true;
      if (cell.colSpan > 1) {
        // A merged amount can occupy any of these columns. Keep full width for all of them.
        if (number) for (let column = cell.column; column < cell.column + cell.colSpan; column++) evidence[column].data = true;
        continue;
      }
      if (number) evidence[cell.column].data = true;
      else if (decoration(text)) evidence[cell.column].decoration = true;
      else if (text) evidence[cell.column].text = true;
    }
  }
  const labelColumn = evidence.findIndex(column => column.label);
  return evidence.map((column, index) => ({ index, kind: index === labelColumn ? "label"
    : column.data || column.text ? "data" : column.decoration ? "decoration" : "empty" }));
}

function translatedUnitCaption(caption: string): string {
  const parsed = caption.match(/^(?:(amounts|(?:U\.?S\.?\s+)?dollars|USD|[$€£¥])\s+)?in\s+(thousands|millions|billions)(?:\s+of\s+((?:U\.?S\.?\s+)?dollars))?(?:\s*,?\s*except\s+((?:shares?\s+and\s+)?per[ -]share\s+(?:data|amounts)))?$/i);
  if (!parsed) return caption;
  const magnitudes: Record<string, string> = { thousands: "千", millions: "百万", billions: "十亿" };
  const magnitude = magnitudes[parsed[2].toLowerCase()];
  const statedCurrency = parsed[3] || (parsed[1]?.toLowerCase() === "amounts" ? "" : parsed[1]) || "";
  if (/^dollars$/i.test(statedCurrency)) return caption;
  // A currency symbol stays a symbol: $ and ¥ alone do not identify one currency.
  const currency = /^(?:USD|U\.?S\.?\s+dollars)$/i.test(statedCurrency) ? "美元"
    : statedCurrency ? ` ${statedCurrency}` : "";
  const exception = parsed[4] ? /^shares?\s+and/i.test(parsed[4]) ? "，股份数量及每股数据除外" : "，每股数据除外" : "";
  return `单位：${magnitude}${currency}${exception}`;
}

/** Translate only units explicitly stated in the heading. Original wording remains in the
 * table's precedingText; XBRL facts and untagged original amounts are never converted here. */
export function statementUnitCaption(table: StatementTable): string | null {
  const candidates = [table.precedingText, ...table.rows.slice(0, 8).map(statementRowText)];
  for (const text of candidates) {
    // Retain a qualified currency phrase even when we cannot translate it. Matching only the
    // suffix "dollars in millions" would lose "Canadian" (or another issuer-stated currency).
    const match = text.match(/(?:[$€£¥]\s*|\b(?:(?:amounts|USD|(?:[A-Za-z][A-Za-z.]*\s+){0,3}dollars)\s+)?)in\s+(?:thousands|millions|billions)(?:\s+of\s+(?:[A-Za-z][A-Za-z.]*\s+){0,3}dollars)?(?:\s*,?\s*except\s+[^.;)\n]{1,100})?/i);
    if (match) return translatedUnitCaption(match[0].trim());
  }
  return null;
}
