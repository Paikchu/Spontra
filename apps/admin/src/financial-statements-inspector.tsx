import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, FileText, LoaderCircle, Maximize2, Search, X } from "lucide-react";
import type { DisclosureAuditSummary } from "@/shared/analysis-contract/disclosure-audit";
import type { FinancialStatements, StatementCell, StatementTable } from "@/shared/analysis-runtime/financial-data/financial-statements";
import { adminApi, AdminApiError } from "./admin-api";
import { classifyStatementCategory, STATEMENT_CATEGORY_LABELS, statementColumnLayout, statementUnitCaption, translateStatementLabel, type StatementCategory } from "./financial-statement-presentation";
import "./financial-statements.css";

const categoryOrder: StatementCategory[] = ["balance", "income", "cashflow", "other", "notes"];
const categoryDescriptions: Record<StatementCategory, string> = {
  balance: "公司拥有的资产、承担的负债与股东权益",
  income: "收入、成本与最终利润",
  cashflow: "经营、投资和融资活动带来的现金变化",
  other: "综合收益、股东权益变化及其他财务报表",
  notes: "主要财务项目的补充说明与明细",
};
const formLabel = (form: string) => `${/^(?:10-K|20-F)/.test(form) ? "年报" : form.startsWith("6-K") ? "中期报表（6-K 申报日）" : "季报"}${form.endsWith("/A") ? "（修订）" : ""}`;
const cellKey = (row: number, cell: StatementCell) => `${row}:${cell.column}`;
const hasNumericFact = (cell: StatementCell) => cell.facts.some(fact => fact.status === "parsed" && fact.value !== null && fact.value.trim() !== "" && Number.isFinite(Number(fact.value)));

function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const result = [], lower = text.toLocaleLowerCase(), needle = query.toLocaleLowerCase();
  let cursor = 0, position = lower.indexOf(needle);
  while (position !== -1) {
    result.push(text.slice(cursor, position), <mark key={position}>{text.slice(position, position + query.length)}</mark>);
    cursor = position + query.length;
    position = lower.indexOf(needle, cursor);
  }
  result.push(text.slice(cursor));
  return <>{result}</>;
}

/** Never split a merged heading from the rows that belong to it. */
function headingRowCount(table: StatementTable) {
  const firstValue = table.rows.findIndex(row => row.cells.some(hasNumericFact));
  let explicit = 0;
  for (const row of table.rows) { if (!row.cells.length || row.cells.some(cell => !cell.header)) break; explicit++; }
  const count = firstValue > 0 && firstValue <= 6 ? firstValue : explicit;
  return table.rows.slice(0, count).some((row, index) => row.cells.some(cell => index + cell.rowSpan > count)) ? 0 : count;
}

export function FinancialStatementsInspector({ ticker, documents, onUnauthorized, onRequestUpdate }: {
  ticker: string; documents: DisclosureAuditSummary[]; onUnauthorized: () => void; onRequestUpdate?: () => void;
}) {
  const filings = useMemo(() => documents.filter(document => /^(?:10-[QK]|20-F)(?:\/A)?$/.test(document.source.form)
    || (/^6-K(?:\/A)?$/.test(document.source.form) && document.statements?.status === "extracted" && document.statements.tables > 0))
    .sort((a, b) => b.source.reportDate.localeCompare(a.source.reportDate) || b.source.filedAt.localeCompare(a.source.filedAt)), [documents]);
  const [selected, setSelected] = useState("");
  const [resource, setResource] = useState<{ key: string; data: FinancialStatements } | null>(null);
  const [tableId, setTableId] = useState("");
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [focusedRow, setFocusedRow] = useState<number | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [dense, setDense] = useState(false);
  const unauthorized = useRef(onUnauthorized);
  const rememberedTable = useRef<{ key: string; id: string }>({ key: "", id: "" });
  const categoryChoices = useRef<Partial<Record<StatementCategory, string>>>({});
  const grid = useRef<HTMLDivElement>(null), expandedGrid = useRef<HTMLDivElement>(null), dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const doc = filings.find(document => document.documentId === selected)
    ?? filings.find(document => document.statements?.status === "extracted" && document.statements.tables > 0)
    ?? filings[0];
  const documentId = doc?.documentId;
  const documentKey = `${ticker}:${documentId ?? ""}`;
  const revision = doc ? `${doc.archivedAt}:${doc.contentSha256}:${doc.statements?.version ?? ""}:${doc.statements?.status ?? ""}` : "";
  const data = resource?.key === documentKey ? resource.data : null;
  const table = data?.tables.find(candidate => candidate.id === tableId);
  const category = table ? classifyStatementCategory(table.section) : undefined;
  const categories = categoryOrder.filter(kind => data?.tables.some(candidate => classifyStatementCategory(candidate.section) === kind));
  const categoryTables = data?.tables.filter(candidate => classifyStatementCategory(candidate.section) === category) ?? [];
  const search = query.trim();
  const matches = useMemo(() => table?.rows.flatMap((row, index) => row.cells.filter(cell => search && `${cell.text} ${translateStatementLabel(cell.text)}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(cell => cellKey(index, cell))) ?? [], [table, search]);
  const activeMatch = matches.length ? ((matchIndex % matches.length) + matches.length) % matches.length : 0;
  const activeCell = matches[activeMatch];
  const columns = useMemo(() => table ? statementColumnLayout(table) : [], [table]);
  const unitCaption = table ? statementUnitCaption(table) : null;
  const headerRows = table ? headingRowCount(table) : 0;

  useEffect(() => { unauthorized.current = onUnauthorized; }, [onUnauthorized]);
  useEffect(() => {
    if (!documentId) return;
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) { setLoading(true); setError(false); } });
    void adminApi<FinancialStatements>(`financials/companies/${ticker}/documents/${documentId}/statements`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      const remembered = rememberedTable.current;
      const preserved = remembered.key === documentKey && result.tables.find(candidate => candidate.id === remembered.id);
      const preferred = preserved || categoryOrder.flatMap(kind => result.tables.filter(candidate => classifyStatementCategory(candidate.section) === kind))[0];
      if (remembered.key !== documentKey) { categoryChoices.current = {}; setQuery(""); setMatchIndex(0); setFocusedRow(null); }
      rememberedTable.current = { key: documentKey, id: preferred?.id ?? "" };
      setTableId(preferred?.id ?? "");
      setResource({ key: documentKey, data: result });
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return;
      if (failure instanceof AdminApiError && failure.status === 401) unauthorized.current();
      else setError(true);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [ticker, documentId, documentKey, revision, retry]);

  useEffect(() => {
    const modal = dialog.current;
    if (expanded && modal && !modal.open) modal.showModal();
    else if (!expanded && modal?.open) modal.close();
  }, [expanded]);
  useEffect(() => {
    if (!activeCell) return;
    const frame = requestAnimationFrame(() => {
      const container = expanded ? expandedGrid.current : grid.current;
      container?.querySelector<HTMLElement>(`[data-search-cell="${activeCell}"]`)?.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeCell, expanded]);

  function chooseTable(value: string) {
    const next = data?.tables.find(candidate => candidate.id === value);
    if (!next) return;
    rememberedTable.current = { key: documentKey, id: value };
    categoryChoices.current[classifyStatementCategory(next.section)] = value;
    setTableId(value); setMatchIndex(0); setFocusedRow(null);
  }
  function chooseCategory(value: StatementCategory) {
    const options = data?.tables.filter(candidate => classifyStatementCategory(candidate.section) === value) ?? [];
    chooseTable(options.find(candidate => candidate.id === categoryChoices.current[value])?.id ?? options[0]?.id ?? "");
  }
  function moveMatch(direction: number) { if (matches.length) setMatchIndex(activeMatch + direction); }

  function renderRows(start: number, end: number) {
    return table!.rows.slice(start, end).map((row, offset) => {
      const rowIndex = start + offset;
      const label = row.cells.find(cell => columns[cell.column]?.kind === "label" && cell.text)?.text ?? "";
      const total = /^(?:total\b|net (?:income|loss|cash)|operating (?:income|loss)|income before)/i.test(label.trim());
      const foldedSigns = new Set<number>(), parenthesized = new Set<number>();
      const openingSign = new Set<number>(), closingSign = new Set<number>();
      // The filing sometimes puts each parenthesis in its own cell. Keep those cells and
      // spans, but place the visible glyphs next to their amount so columns cannot split them.
      for (let index = 0; index < row.cells.length - 2; index++) {
        const [open, amount, close] = row.cells.slice(index, index + 3);
        if (open.text.trim() === "(" && close.text.trim() === ")" && /^[+−-]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)$/.test(amount.text.trim())
          && [open, amount, close].every(cell => cell.colSpan === 1 && cell.rowSpan === 1)
          && amount.column === open.column + 1 && close.column === amount.column + 1) {
          foldedSigns.add(index); foldedSigns.add(index + 2); parenthesized.add(index + 1);
        }
      }
      for (let index = 0; index < row.cells.length - 1; index++) {
        const [first, second] = row.cells.slice(index, index + 2);
        if (first.colSpan !== 1 || first.rowSpan !== 1 || second.colSpan !== 1 || second.rowSpan !== 1 || second.column !== first.column + 1) continue;
        if (/^\([+−-]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)$/.test(first.text.trim()) && second.text.trim() === ")") {
          closingSign.add(index); foldedSigns.add(index + 1);
        } else if (first.text.trim() === "(" && /^[+−-]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)\)$/.test(second.text.trim())) {
          openingSign.add(index + 1); foldedSigns.add(index);
        }
      }
      return <tr key={rowIndex} data-focused={focusedRow === rowIndex} data-total={total} onClick={() => setFocusedRow(previous => previous === rowIndex ? null : rowIndex)}>
        {row.cells.map((cell, index) => {
          const Tag = cell.header ? "th" : "td";
          const key = cellKey(rowIndex, cell), kind = columns[cell.column]?.kind;
          const translated = kind === "label" ? translateStatementLabel(cell.text) : cell.text;
          const showOriginalMatch = search && translated !== cell.text && cell.text.toLocaleLowerCase().includes(search.toLocaleLowerCase()) && !translated.toLocaleLowerCase().includes(search.toLocaleLowerCase());
          return <Tag key={index} colSpan={cell.colSpan} rowSpan={cell.rowSpan} data-column-kind={kind} data-numeric={hasNumericFact(cell)} data-empty={!cell.text} data-search-cell={key} data-active-match={activeCell === key} data-folded-sign={foldedSigns.has(index)} title={translated !== cell.text ? cell.text : undefined}>
            <span aria-hidden={foldedSigns.has(index) || undefined}>{(parenthesized.has(index) || openingSign.has(index)) && "("}<HighlightedText text={translated || "\u00a0"} query={search} />{(parenthesized.has(index) || closingSign.has(index)) && ")"}</span>
            {showOriginalMatch && <small className="fs-original-match"><HighlightedText text={cell.text} query={search} /></small>}
          </Tag>;
        })}
      </tr>;
    });
  }

  function reader(isExpanded: boolean) {
    if (!table || !category) return null;
    return <div className="fs-reader" data-density={dense ? "compact" : "comfortable"}>
      <div className="fs-reader-heading">
        <div className="fs-heading-copy"><h3 id={`${titleId}-${isExpanded ? "expanded" : "inline"}`}>{STATEMENT_CATEGORY_LABELS[category]}</h3><p>{categoryDescriptions[category]}</p><p className="fs-original-title" lang="en">{table.section}</p></div>
        <div className="fs-reader-tools">
          <label className="fs-search"><Search size={16} aria-hidden="true" /><input aria-label="搜索表内项目" placeholder="搜索表内项目" value={query} onChange={event => { setQuery(event.target.value); setMatchIndex(0); }} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); moveMatch(event.shiftKey ? -1 : 1); } }} />{query && <button type="button" aria-label="清除表内搜索" onClick={() => { setQuery(""); setMatchIndex(0); }}><X size={14} /></button>}</label>
          {search && <span className="fs-match-count" role="status">{matches.length ? `${activeMatch + 1} / ${matches.length}` : "无匹配"}</span>}
          <div className="fs-search-navigation"><button type="button" className="fs-icon-button" aria-label="上一个匹配项目" disabled={!matches.length} onClick={() => moveMatch(-1)}><ArrowUp size={16} /></button><button type="button" className="fs-icon-button" aria-label="下一个匹配项目" disabled={!matches.length} onClick={() => moveMatch(1)}><ArrowDown size={16} /></button></div>
          {isExpanded ? <button type="button" className="fs-button" onClick={() => setExpanded(false)}><X size={15} />收起阅读</button> : <button type="button" className="fs-button" onClick={() => setExpanded(true)}><Maximize2 size={15} />展开阅读</button>}
        </div>
      </div>
      <div className="fs-table-options">{unitCaption && <span>{unitCaption}</span>}<button type="button" className="fs-density" aria-pressed={dense} onClick={() => setDense(value => !value)}>紧凑显示</button></div>
      <div className="fs-table-scroll" ref={isExpanded ? expandedGrid : grid} tabIndex={0} aria-label={`${STATEMENT_CATEGORY_LABELS[category]}，可横向和纵向滚动`}>
        <table className="fs-table" aria-labelledby={`${titleId}-${isExpanded ? "expanded" : "inline"}`}>
          <colgroup>{columns.map(column => <col key={column.index} data-column-kind={column.kind} />)}</colgroup>
          {headerRows > 0 && <thead>{renderRows(0, headerRows)}</thead>}
          <tbody>{renderRows(headerRows, table.rows.length)}</tbody>
        </table>
      </div>
      <div className="fs-reader-footer"><span>金额中的括号表示负数；空白与破折号按原表保留。</span>{table.precedingText && <details className="fs-notes"><summary>报表说明<ChevronDown size={15} aria-hidden="true" /></summary><p>{table.precedingText}</p></details>}</div>
    </div>;
  }

  return <section className="fs-workspace" aria-label="财务报表">
    {!!filings.length && <div className="fs-report-control"><label htmlFor={`${titleId}-report`}>财报期间</label><div className="fs-select-wrap"><select id={`${titleId}-report`} aria-label="选择财报期间" value={documentId ?? ""} onChange={event => setSelected(event.target.value)}>{filings.map(filing => <option key={filing.documentId} value={filing.documentId}>{filing.source.reportDate} · {formLabel(filing.source.form)}</option>)}</select><ChevronDown size={15} aria-hidden="true" /></div>{loading && data && <span className="fs-refreshing" role="status"><LoaderCircle size={13} className="fs-spin" />更新中</span>}</div>}
    {loading && documentId && !data ? <div className="fs-empty" role="status"><LoaderCircle className="fs-spin" size={24} /><h3>正在读取财务报表</h3></div> : !filings.length ? <div className="fs-empty"><FileText size={30} /><h3>这家公司的报表还未准备好</h3><p>更新数据后，在这里阅读财务报表。</p>{onRequestUpdate && <button type="button" className="fs-button fs-primary" onClick={onRequestUpdate}>获取财报数据</button>}</div> : !error && data && !table ? <div className="fs-empty"><FileText size={30} /><h3>本期暂无可阅读的报表</h3><p>可切换其他财报期间，或更新数据后重试。</p><button type="button" className="fs-button" onClick={onRequestUpdate ?? (() => setRetry(value => value + 1))}>{onRequestUpdate ? "更新数据" : "重新读取"}</button></div> : null}
    {error && documentId && <div className="fs-error" role="alert"><span>{data ? "暂时无法刷新，已保留当前报表。" : "暂时无法读取报表，请重试。"}</span><button type="button" className="fs-button" onClick={() => setRetry(value => value + 1)}>重新读取</button></div>}
    {table && <><nav className="fs-tabs" aria-label="报表类别">{categories.map(kind => <button type="button" key={kind} aria-pressed={kind === category} onClick={() => chooseCategory(kind)}>{STATEMENT_CATEGORY_LABELS[kind]}</button>)}</nav>
      {categoryTables.length > 1 && <div className="fs-table-picker"><label htmlFor={`${titleId}-table`}>选择{category && STATEMENT_CATEGORY_LABELS[category]}</label><div className="fs-select-wrap"><select id={`${titleId}-table`} aria-label="选择财务报表或附注表格" value={tableId} onChange={event => chooseTable(event.target.value)}>{categoryTables.map((candidate, index) => <option key={candidate.id} value={candidate.id}>{translateStatementLabel(candidate.section)}{categoryTables.filter(other => other.section === candidate.section).length > 1 ? ` · 表 ${index + 1}` : ""}</option>)}</select><ChevronDown size={15} aria-hidden="true" /></div></div>}
      {reader(false)}</>}
    <dialog ref={dialog} className="fs-expanded" aria-labelledby={`${titleId}-expanded`} onCancel={() => setExpanded(false)} onClose={() => setExpanded(false)}>{expanded && reader(true)}</dialog>
  </section>;
}
