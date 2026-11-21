import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowsClockwiseIcon as RefreshCw, CheckIcon as Check, CopyIcon as Copy, MagnifyingGlassIcon as Search } from "@phosphor-icons/react";
import type { MaterialPage, MaterialSnapshot, MaterialState, MaterialTable } from "@/shared/analysis-contract/filing-material";
import { CompanyLogo } from "@/packages/web/src/company-logo";
import { adminApi, AdminApiError } from "./admin-api";
import { usePageActive } from "./admin-page";
import "./filing-materials.css";

const FilingMarkdown = lazy(async () => ({ default: (await import("./filing-markdown")).FilingMarkdown }));

type Props = { onAuthenticated: () => void; onUnauthorized: () => void };
type Tab = "markdown" | "tables";
type ReportPage = Pick<MaterialPage, "text" | "nextCursor">;
type ReadyMaterial = Extract<MaterialState, { status: "ready" }>;
const supportsReadingEdition = (filing: MaterialState["filing"]) => /\.html?$/i.test(filing.primaryDocument);
type ReadingEdition = "preprocessed" | "organized";
type ReadingEditionProgress = { status: "preparing"; progress: string } | { status: "ready" };
type TableReadResponse = {
  ref: MaterialSnapshot["ref"];
  table: MaterialTable;
  csv: string;
  sourceId: string;
  rowStart: number;
  rowEnd: number;
  columns: string[];
  nextCursor: string | null;
};

const STATUS_LABEL: Record<MaterialState["status"], string> = {
  ready: "已就绪",
  preparing: "整理中",
  blocked: "已阻塞",
};

function materialKey(m: MaterialState) {
  return `${m.filing.ticker}:${m.filing.accession}`;
}

function initialSelection() {
  const params = new URLSearchParams(window.location.search);
  return { ticker: (params.get("ticker") ?? "").toUpperCase(), accession: params.get("accession") ?? "" };
}

export function FilingMaterials({ onAuthenticated, onUnauthorized }: Props) {
  const [materials, setMaterials] = useState<MaterialState[] | null>(null);
  const [search, setSearch] = useState("");
  const [blockedOnly, setBlockedOnly] = useState(false);
  const [selection, setSelection] = useState(initialSelection);
  const [tab, setTab] = useState<Tab>("markdown");
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");

  const [detail, setDetail] = useState<MaterialState | null>(null);
  const [snapshot, setSnapshot] = useState<MaterialSnapshot | null>(null);
  const [mdPage, setMdPage] = useState<ReportPage | null>(null);
  const [mdLoading, setMdLoading] = useState(false);
  const materialRequest = useRef<AbortController | null>(null);

  const [tableQuery, setTableQuery] = useState("");
  const [tablesList, setTablesList] = useState<MaterialTable[]>([]);
  const [tablesCursor, setTablesCursor] = useState<string | null>(null);
  const [selectedTableId, setSelectedTableId] = useState<string>("");
  const [tableDetail, setTableDetail] = useState<TableReadResponse | null>(null);
  const [copiedCsv, setCopiedCsv] = useState(false);

  const [actionBusy, setActionBusy] = useState(false);
  const [actionNote, setActionNote] = useState("");
  const [readingRun, setReadingRun] = useState<{ key: string; running: boolean; note: string } | null>(null);
  const readingRequest = useRef<AbortController | null>(null);
  useEffect(() => () => readingRequest.current?.abort(), []);

  const callbacks = useRef({ onAuthenticated, onUnauthorized });
  useEffect(() => { callbacks.current = { onAuthenticated, onUnauthorized }; }, [onAuthenticated, onUnauthorized]);
  const visible = usePageActive();

  const fail = useCallback((e: unknown) => {
    if (e instanceof AdminApiError && e.status === 401) callbacks.current.onUnauthorized();
    else setError(e instanceof Error ? e.message : String(e));
  }, []);

  useEffect(() => {
    const c = new AbortController();
    void adminApi<{ materials: MaterialState[] }>("library", { signal: c.signal }).then(res => {
      const sorted = [...res.materials].sort((a, b) => (b.filing.filedAt || "").localeCompare(a.filing.filedAt || ""));
      setMaterials(sorted);
      setError("");
      callbacks.current.onAuthenticated();
    }).catch(e => { if (!c.signal.aborted) fail(e); });
    return () => c.abort();
  }, [refresh, fail]);

  const companies = useMemo(() => {
    const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const byTicker = new Map<string, MaterialState[]>();
    for (const material of materials ?? []) {
      if (blockedOnly && material.status !== "blocked") continue;
      const { ticker, companyName, form, accession, reportDate, filedAt } = material.filing;
      const description = `${ticker} ${companyName} ${form} ${accession} ${reportDate} ${filedAt}`.toLowerCase();
      if (!terms.every(term => description.includes(term))) continue;
      const reports = byTicker.get(ticker);
      if (reports) reports.push(material);
      else byTicker.set(ticker, [material]);
    }
    return [...byTicker].sort(([a], [b]) => a.localeCompare(b));
  }, [materials, search, blockedOnly]);

  const company = companies.find(([ticker]) => ticker === selection.ticker) ?? companies[0];
  const reports = company?.[1] ?? [];
  const requestedReport = company?.[0] === selection.ticker
    ? reports.find(report => report.filing.accession === selection.accession)
    : undefined;
  const selectedMaterial = requestedReport ?? reports[0] ?? null;
  const selectedKey = selectedMaterial ? materialKey(selectedMaterial) : "";

  const loadMarkdown = useCallback(async (material: ReadyMaterial, signal: AbortSignal, cursor?: string) => {
    const { ticker, accession } = material.filing;
    const endpoint = `library/materials/${ticker}/${accession}`;
    const params = new URLSearchParams({ version: material.ref.version });
    setMdLoading(true);
    try {
      if (!cursor && supportsReadingEdition(material.filing)) {
        try {
          const { markdown } = await adminApi<{ markdown: string }>(`${endpoint}/reading-edition/organized?${params}`, { signal });
          if (!signal.aborted) setMdPage({ text: markdown, nextCursor: null });
          return;
        } catch (error) {
          if (!(error instanceof AdminApiError) || error.status !== 404) throw error;
        }
      }
      if (cursor) params.set("cursor", cursor);
      const page = await adminApi<ReportPage>(`${endpoint}/markdown?${params}`, { signal });
      if (!signal.aborted) setMdPage(previous => ({ text: (cursor ? previous?.text ?? "" : "") + page.text, nextCursor: page.nextCursor }));
    } catch (error) {
      if (!signal.aborted) fail(error);
    } finally {
      if (!signal.aborted) setMdLoading(false);
    }
  }, [fail]);

  const loadTables = useCallback(async (material: ReadyMaterial, name = "", cursor = "", signal?: AbortSignal) => {
    const { ticker, accession } = material.filing;
    const params = new URLSearchParams({ version: material.ref.version });
    if (name.trim()) params.set("name", name.trim());
    if (cursor) params.set("cursor", cursor);
    try {
      const res = await adminApi<{ tables: MaterialTable[]; nextCursor: string | null }>(`library/materials/${ticker}/${accession}/tables?${params}`, { signal });
      if (signal?.aborted) return;
      setTablesList(prev => cursor ? [...prev, ...res.tables] : res.tables);
      setTablesCursor(res.nextCursor);
      if (!cursor) {
        setSelectedTableId(res.tables[0]?.tableId ?? "");
        if (!res.tables.length) setTableDetail(null);
      }
    } catch (error) {
      if (!signal?.aborted) fail(error);
    }
  }, [fail]);

  const loadTableDetail = useCallback(async (material: ReadyMaterial, tableId: string, signal: AbortSignal) => {
    const { ticker, accession } = material.filing;
    const version = encodeURIComponent(material.ref.version);
    try {
      const res = await adminApi<TableReadResponse>(`library/materials/${ticker}/${accession}/tables/${encodeURIComponent(tableId)}?version=${version}`, { signal });
      if (!signal.aborted) setTableDetail(res);
    } catch (error) {
      if (!signal.aborted) fail(error);
    }
  }, [fail]);

  useEffect(() => {
    if (!selectedMaterial) {
      setDetail(null);
      setSnapshot(null);
      setMdPage(null);
      setTablesList([]);
      setTableDetail(null);
      return;
    }
    const { ticker, accession } = selectedMaterial.filing;
    setActionNote("");
    setDetail(null);
    setSnapshot(null);
    setMdPage(null);
    setMdLoading(false);
    setTablesList([]);
    setTablesCursor(null);
    setSelectedTableId("");
    setTableQuery("");
    setTableDetail(null);
    const c = new AbortController();
    materialRequest.current = c;

    void adminApi<MaterialState>(`library/materials/${ticker}/${accession}`, { signal: c.signal })
      .then(d => {
        if (c.signal.aborted) return;
        setDetail(d);
        if (d.status === "ready") {
          void adminApi<MaterialSnapshot>(`library/materials/${ticker}/${accession}/index?version=${encodeURIComponent(d.ref.version)}`, { signal: c.signal })
            .then(idx => { if (!c.signal.aborted) setSnapshot(idx); })
            .catch(e => { if (!c.signal.aborted) fail(e); });
          void loadMarkdown(d, c.signal);
          void loadTables(d, "", "", c.signal);
        }
      })
      .catch(e => { if (!c.signal.aborted) fail(e); });

    return () => c.abort();
  }, [selectedMaterial, fail, loadMarkdown, loadTables]);

  useEffect(() => {
    if (!detail || detail.status !== "ready" || materialKey(detail) !== selectedKey || !selectedTableId || tab !== "tables") return;
    const controller = new AbortController();
    void loadTableDetail(detail, selectedTableId, controller.signal);
    return () => controller.abort();
  }, [detail, selectedKey, selectedTableId, tab, loadTableDetail]);

  useEffect(() => {
    if (!selectedMaterial || !visible.current) return;
    try {
      window.history.replaceState(null, "", `${window.location.pathname}?${new URLSearchParams({ ticker: selectedMaterial.filing.ticker, accession: selectedMaterial.filing.accession })}`);
    } catch { /* ignore */ }
  }, [selectedMaterial, visible]);

  async function triggerPrepare(retryFailedSources: boolean) {
    if (!selectedMaterial) return;
    const { ticker, accession } = selectedMaterial.filing;
    setActionBusy(true);
    setActionNote("");
    try {
      const body = retryFailedSources
        ? { retryFailedSources: true, requestId: crypto.randomUUID() }
        : {};
      await adminApi(`library/materials/${ticker}/${accession}/prepare`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setActionNote(retryFailedSources ? "已安排重试失败文件。" : "已安排重新整理材料。");
      setRefresh(n => n + 1);
    } catch (e) {
      fail(e);
    } finally {
      setActionBusy(false);
    }
  }

  async function triggerPilotPrepare() {
    if (!selectedMaterial) return;
    const { ticker, accession } = selectedMaterial.filing;
    setActionBusy(true);
    setActionNote("");
    try {
      await adminApi(`library/materials/${ticker}/${accession}/prepare-pilot`, {
        method: "POST",
        body: JSON.stringify({ requestId: crypto.randomUUID(), retryFailedSources: false }),
      });
      setActionNote("已安排分批整理。");
      setRefresh(n => n + 1);
    } catch (e) {
      fail(e);
    } finally {
      setActionBusy(false);
    }
  }

  async function prepareReadingEdition(ref: MaterialSnapshot["ref"]) {
    if (readingRequest.current) return;
    const controller = new AbortController();
    readingRequest.current = controller;
    const key = `${ref.ticker}:${ref.accession}`;
    setError("");
    setReadingRun({ key, running: true, note: "正在识别申报目录…" });
    const endpoint = `library/materials/${ref.ticker}/${ref.accession}/reading-edition?version=${ref.version}`;
    try {
      for (;;) {
        const result = await adminApi<ReadingEditionProgress>(endpoint, { method: "POST", signal: controller.signal });
        if (result.status === "ready") {
          setReadingRun({ key, running: false, note: "阅读稿已生成。" });
          setRefresh(n => n + 1);
          return;
        }
        setReadingRun({ key, running: true, note: result.progress });
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      setReadingRun({ key, running: false, note: "" });
      fail(error);
    } finally {
      readingRequest.current = null;
    }
  }

  async function downloadReadingEdition(ref: MaterialSnapshot["ref"], edition: ReadingEdition) {
    const endpoint = `library/materials/${ref.ticker}/${ref.accession}/reading-edition/${edition}?version=${ref.version}`;
    setError("");
    try {
      const { markdown } = await adminApi<{ markdown: string }>(endpoint);
      const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${ref.ticker}-${ref.accession}-${edition}.md`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      fail(error);
    }
  }

  function copyCsv() {
    if (!tableDetail?.csv) return;
    void navigator.clipboard?.writeText(tableDetail.csv).then(() => {
      setCopiedCsv(true);
      setTimeout(() => setCopiedCsv(false), 1500);
    });
  }

  const hasSelectedDetail = detail !== null && materialKey(detail) === selectedKey;
  const currentMaterial = hasSelectedDetail ? detail : selectedMaterial;
  const reportPage = hasSelectedDetail ? mdPage : null;
  const currentSnapshot = hasSelectedDetail ? snapshot : null;

  return (
    <div className="ra-workspace fm2-workspace">
      <section className="ra-list" aria-label="财报公司列表">
        <div className="ra-filters">
          <label className="ra-search">
            <Search size={17} />
            <input type="search" aria-label="搜索公司或财报" placeholder="公司或财报" autoCapitalize="none" spellCheck={false} value={search} onChange={e => setSearch(e.target.value)} />
          </label>
          <button className="bs-icon" aria-label="刷新" onClick={() => setRefresh(n => n + 1)}>
            <RefreshCw size={17} />
          </button>
        </div>
        <div className="fm2-filters" role="group" aria-label="按材料状态筛选">
          <button type="button" className="fm2-filter-pill" aria-pressed={!blockedOnly} onClick={() => setBlockedOnly(false)}>全部</button>
          <button type="button" className="fm2-filter-pill" aria-pressed={blockedOnly} onClick={() => setBlockedOnly(true)}>已阻塞</button>
        </div>
        <div className="ra-list-caption">{materials ? `${companies.length} 家公司` : "加载中"}</div>
        {error && <p className="ra-error" role="alert">{error}</p>}
        <div className="ra-list-scroll">
          {companies.map(([ticker, filings]) => (
            <button key={ticker} type="button" className="ra-report-row" aria-pressed={company?.[0] === ticker}
              onClick={() => setSelection({
                ticker, accession: company?.[0] === ticker ? selectedMaterial?.filing.accession ?? "" : "",
              })}>
              <CompanyLogo symbol={ticker} />
              <span className="ra-row-info"><strong>{ticker}</strong><small>{filings.length} 份</small></span>
            </button>
          ))}
        </div>
      </section>

      <section className="ra-list fm2-report-list" aria-label="财报报告列表">
        <div className="ra-list-caption fm2-report-list-caption">
          <span>报告</span>
          {company && <span>{reports.length} 份</span>}
        </div>
        <div className="ra-list-scroll" key={company?.[0]}>
          {reports.map(report => {
            const { ticker, accession, form, filedAt, reportDate } = report.filing;
            return (
              <button type="button" className="ra-report-row fm2-report-row" key={accession}
                aria-pressed={materialKey(report) === selectedKey}
                onClick={() => setSelection({ ticker, accession })}>
                <span className="fm2-report-row-head">
                  <strong>{form}</strong>
                  <span className={`fm2-badge ${report.status}`}>{STATUS_LABEL[report.status]}</span>
                </span>
                <span className="fm2-report-row-date">{filedAt || reportDate}</span>
                <code>{accession}</code>
              </button>
            );
          })}
        </div>
      </section>

      <section className="ra-detail" aria-label="财报报告与数据表格">
        {!currentMaterial ? (
          <p className="bs-empty">{materials ? "没有符合筛选条件的财报。" : "正在加载财报…"}</p>
        ) : (
          <>
            <div className="fm2-head">
              <div className="fm2-title">
                <h2>{currentMaterial.filing.ticker} · {currentMaterial.filing.companyName}</h2>
                {currentMaterial.status !== "ready" && <span className={`fm2-badge ${currentMaterial.status}`}>{STATUS_LABEL[currentMaterial.status]}</span>}
              </div>
              <div className="fm2-meta">
                <span>报告期：<strong>{currentMaterial.filing.reportDate || "—"}</strong></span>
              </div>
            </div>

            <nav className="bs-views" aria-label="财报材料视图">
              <button type="button" aria-pressed={tab === "markdown"} onClick={() => setTab("markdown")}>Markdown 报告</button>
              <button type="button" aria-pressed={tab === "tables"} onClick={() => setTab("tables")}>数据表格{currentSnapshot ? ` (${currentSnapshot.tables.length})` : ""}</button>
            </nav>

            {actionNote && <div className="fm2-badge ready">{actionNote}</div>}

            {tab === "markdown" && (
              <div className="fm2-panel">
                {currentSnapshot && supportsReadingEdition(currentMaterial.filing) && (
                  <div className="fm2-bar">
                    <div className="fm2-actions">
                      <button type="button" className="fm2-btn primary" disabled={readingRun?.running} onClick={() => void prepareReadingEdition(currentSnapshot.ref)}>
                        生成阅读稿
                      </button>
                      <button type="button" className="fm2-btn" onClick={() => void downloadReadingEdition(currentSnapshot.ref, "preprocessed")}>
                        下载预处理稿
                      </button>
                      <button type="button" className="fm2-btn" onClick={() => void downloadReadingEdition(currentSnapshot.ref, "organized")}>
                        下载整理稿
                      </button>
                    </div>
                    {readingRun?.key === selectedKey && readingRun.note && <span className="fm2-meta" role="status">{readingRun.note}</span>}
                  </div>
                )}
                {currentMaterial.status !== "ready" ? (
                  <div className="fm2-card">
                    {currentMaterial.status === "preparing" && <p className="fm2-meta" role="status">{currentMaterial.progress}</p>}
                    {currentMaterial.status === "blocked" && (
                      <ul>{currentMaterial.issues.map((issue, idx) => <li key={idx}>{issue}</li>)}</ul>
                    )}
                    <div className="fm2-actions">
                      <button type="button" className="fm2-btn" disabled={actionBusy} onClick={() => void triggerPrepare(false)}>
                        重新整理材料
                      </button>
                      {currentMaterial.status === "blocked" && (
                        <button type="button" className="fm2-btn" disabled={actionBusy} onClick={() => void triggerPrepare(true)}>
                        重试失败文件
                        </button>
                      )}
                      <button type="button" className="fm2-btn" disabled={actionBusy} onClick={() => void triggerPilotPrepare()}>
                        分批整理材料
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="fm2-content fm2-report-scroll">
                    {reportPage?.text ? (
                      <Suspense fallback={<p className="bs-empty" role="status">正在加载报告…</p>}>
                        <FilingMarkdown text={reportPage.text} />
                      </Suspense>
                    ) : (
                      <p className="bs-empty" role="status">{mdLoading || !hasSelectedDetail ? "正在加载报告…" : "暂无报告内容"}</p>
                    )}
                    {reportPage?.nextCursor && (
                      <button type="button" className="fm2-btn" disabled={mdLoading} onClick={() => {
                        const signal = materialRequest.current?.signal;
                        if (signal) void loadMarkdown(currentMaterial, signal, reportPage.nextCursor!);
                      }}>
                        {mdLoading ? "加载中…" : "加载下一段"}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {tab === "tables" && (
              <div className="fm2-panel">
                {currentMaterial.status !== "ready" ? (
                  <p className="bs-empty">当前材料状态为「{STATUS_LABEL[currentMaterial.status]}」，尚未生成结构化表格。</p>
                ) : (
                  <div className="fm2-split">
                    <aside className="fm2-toc" aria-label="表格列表">
                      <form onSubmit={e => { e.preventDefault(); void loadTables(currentMaterial, tableQuery, "", materialRequest.current?.signal); }} style={{ marginBottom: 8 }}>
                        <input
                          aria-label="筛选表格名称"
                          placeholder="筛选表名/关键字，回车搜索"
                          value={tableQuery}
                          onChange={e => setTableQuery(e.target.value)}
                          style={{ width: "100%", padding: "5px 8px", border: "1px solid var(--line)", borderRadius: 6, background: "transparent", color: "var(--ink)", fontSize: 12 }}
                        />
                      </form>
                      {tablesList.map(t => (
                        <button key={t.tableId} type="button" className="fm2-toc-btn" aria-pressed={selectedTableId === t.tableId} onClick={() => setSelectedTableId(t.tableId)}>
                          <div>{t.title}</div>
                          <small style={{ color: "var(--ink-muted)" }}>{t.table.rows.length} 行 · {t.table.columns.length} 列</small>
                        </button>
                      ))}
                      {tablesCursor && (
                        <button type="button" className="fm2-btn" style={{ width: "100%", marginTop: 8 }} onClick={() => void loadTables(currentMaterial, tableQuery, tablesCursor, materialRequest.current?.signal)}>
                          加载更多表格
                        </button>
                      )}
                    </aside>
                    <div className="fm2-content">
                      {!tableDetail ? (
                        <p className="bs-empty">{tablesList.length ? "加载表格内容中…" : "未提取到匹配表格"}</p>
                      ) : (
                        <>
                          <div className="fm2-bar">
                            <div>
                              <strong>{tableDetail.table.title}</strong>
                              {tableDetail.table.table.unit && <span className="fm2-meta">单位：{tableDetail.table.table.unit}</span>}
                            </div>
                            <div className="fm2-actions">
                              <button type="button" className="fm2-btn" onClick={copyCsv}>
                                {copiedCsv ? <Check size={14} /> : <Copy size={14} />}
                                {copiedCsv ? "已复制 CSV" : "复制 CSV"}
                              </button>
                            </div>
                          </div>
                          {tableDetail.table.description && <p className="fm2-meta" style={{ marginTop: 0 }}>{tableDetail.table.description}</p>}
                          <div className="fm2-table-wrap">
                            <table className="fm2-table">
                              <thead>
                                <tr>
                                  {tableDetail.columns.map((col, idx) => <th key={idx}>{col}</th>)}
                                </tr>
                              </thead>
                              <tbody>
                                {tableDetail.table.table.rows.map((row, rIdx) => (
                                  <tr key={rIdx}>
                                    <td><strong>{row.label}</strong></td>
                                    {row.cells.map((cell, cIdx) => <td key={cIdx}>{cell.text}</td>)}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

          </>
        )}
      </section>
    </div>
  );
}
