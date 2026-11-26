import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowsClockwiseIcon as RefreshCw, CheckIcon as Check, CopyIcon as Copy, MagnifyingGlassIcon as Search } from "@phosphor-icons/react";
import type {
  MaterialBriefResponse,
  MaterialPage,
  MaterialSnapshot,
  MaterialState,
  MaterialTable,
} from "@/shared/analysis-contract/filing-material";
import { CompanyLogo } from "@/packages/web/src/company-logo";
import { adminApi, AdminApiError } from "./admin-api";
import { usePageActive } from "./admin-page";
import "./filing-materials.css";

const FilingMarkdown = lazy(async () => ({ default: (await import("./filing-markdown")).FilingMarkdown }));

type Props = { onAuthenticated: () => void; onUnauthorized: () => void };
type Tab = "brief" | "markdown" | "tables";
type BriefView = "structured" | "markdown" | "json";
type ReportPage = Pick<MaterialPage, "text" | "nextCursor">;
type ReadyMaterial = Extract<MaterialState, { status: "ready" }>;
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

const BRIEF_STATUS_LABEL = {
  idle: "未生成",
  running: "抽取中",
  ready: "已就绪",
  failed: "失败",
} as const;

const TOC_GROUP_LABEL = {
  primary: "主文档",
  exhibit: "附件",
  technical: "技术与提交原件",
} as const;

function materialKey(m: MaterialState) {
  return `${m.filing.ticker}:${m.filing.accession}`;
}

function baseSourceId(id: string) {
  return id.replace(/#(?:(?:rows:)?\d+-\d+|cell:\d+:\d+)$/, "");
}

function initialSelection() {
  const params = new URLSearchParams(window.location.search);
  return { ticker: (params.get("ticker") ?? "").toUpperCase(), accession: params.get("accession") ?? "" };
}

function formatChars(chars: number) {
  return chars >= 1000 ? `${(chars / 1000).toFixed(1)}k 字` : `${chars} 字`;
}

export function FilingMaterials({ onAuthenticated, onUnauthorized }: Props) {
  const [materials, setMaterials] = useState<MaterialState[] | null>(null);
  const [search, setSearch] = useState("");
  const [blockedOnly, setBlockedOnly] = useState(false);
  const [selection, setSelection] = useState(initialSelection);
  const [tab, setTab] = useState<Tab>("brief");
  const [briefView, setBriefView] = useState<BriefView>("structured");
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");

  const [detail, setDetail] = useState<MaterialState | null>(null);
  const [snapshot, setSnapshot] = useState<MaterialSnapshot | null>(null);
  const [briefData, setBriefData] = useState<MaterialBriefResponse | null>(null);
  const [briefBusy, setBriefBusy] = useState(false);

  const [mdPage, setMdPage] = useState<ReportPage | null>(null);
  const [mdLoading, setMdLoading] = useState(false);
  const [activeAnchor, setActiveAnchor] = useState<string>("");
  const materialRequest = useRef<AbortController | null>(null);
  const mdScrollRef = useRef<HTMLDivElement | null>(null);

  const [tableQuery, setTableQuery] = useState("");
  const [tablesList, setTablesList] = useState<MaterialTable[]>([]);
  const [tablesCursor, setTablesCursor] = useState<string | null>(null);
  const [selectedTableId, setSelectedTableId] = useState<string>("");
  const [loadedTable, setLoadedTable] = useState<TableReadResponse | null>(null);
  const [copiedTable, setCopiedTable] = useState<TableReadResponse | null>(null);

  const [actionBusy, setActionBusy] = useState(false);
  const [actionNote, setActionNote] = useState("");

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

  const loadBrief = useCallback(async (material: ReadyMaterial, signal?: AbortSignal) => {
    const { ticker, accession } = material.filing;
    const params = new URLSearchParams({ version: material.ref.version });
    try {
      const res = await adminApi<MaterialBriefResponse>(`library/materials/${ticker}/${accession}/brief?${params}`, { signal });
      if (!signal?.aborted) setBriefData(res);
    } catch (e) {
      if (!signal?.aborted) fail(e);
    }
  }, [fail]);

  const loadMarkdown = useCallback(async (material: ReadyMaterial, signal: AbortSignal, cursor?: string, anchor?: string) => {
    const { ticker, accession } = material.filing;
    const endpoint = `library/materials/${ticker}/${accession}/markdown`;
    const params = new URLSearchParams({ version: material.ref.version });
    if (cursor) params.set("cursor", cursor);
    if (anchor && !cursor) params.set("anchor", anchor);
    setMdLoading(true);
    try {
      const page = await adminApi<ReportPage>(`${endpoint}?${params}`, { signal });
      if (!signal.aborted) {
        setMdPage(previous => ({ text: (cursor ? previous?.text ?? "" : "") + page.text, nextCursor: page.nextCursor }));
        if (!cursor) {
          setActiveAnchor(anchor ?? "");
          mdScrollRef.current?.scrollTo({ top: 0 });
        }
      }
    } catch (e) {
      if (!signal.aborted) fail(e);
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
        setSelectedTableId(prev => (prev && res.tables.some(t => t.tableId === prev) ? prev : res.tables[0]?.tableId ?? ""));
        if (!res.tables.length) setLoadedTable(null);
      }
    } catch (e) {
      if (!signal?.aborted) fail(e);
    }
  }, [fail]);

  const loadTableDetail = useCallback(async (material: ReadyMaterial, tableId: string, signal: AbortSignal) => {
    const { ticker, accession } = material.filing;
    const version = encodeURIComponent(material.ref.version);
    try {
      const res = await adminApi<TableReadResponse>(`library/materials/${ticker}/${accession}/tables/${encodeURIComponent(tableId)}?version=${version}`, { signal });
      if (!signal.aborted) setLoadedTable(res);
    } catch (e) {
      if (!signal?.aborted) fail(e);
    }
  }, [fail]);

  useEffect(() => {
    if (!selectedMaterial) {
      setDetail(null);
      setSnapshot(null);
      setBriefData(null);
      setMdPage(null);
      setTablesList([]);
      setLoadedTable(null);
      return;
    }
    const { ticker, accession } = selectedMaterial.filing;
    setActionNote("");
    setDetail(null);
    setSnapshot(null);
    setBriefData(null);
    setMdPage(null);
    setMdLoading(false);
    setActiveAnchor("");
    setTablesList([]);
    setTablesCursor(null);
    setSelectedTableId("");
    setTableQuery("");
    setLoadedTable(null);
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
          void loadBrief(d, c.signal);
          void loadMarkdown(d, c.signal);
          void loadTables(d, "", "", c.signal);
        }
      })
      .catch(e => { if (!c.signal.aborted) fail(e); });

    return () => c.abort();
  }, [selectedMaterial, fail, loadBrief, loadMarkdown, loadTables]);

  useEffect(() => {
    if (!detail || detail.status !== "ready" || materialKey(detail) !== selectedKey) return;
    if (briefData?.state.status !== "running") return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      void loadBrief(detail, controller.signal);
    }, 3000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [detail, selectedKey, briefData?.state.status, loadBrief]);

  useEffect(() => {
    if (briefData?.state.status === "ready" && detail?.status === "ready") {
      void loadTables(detail, tableQuery, "", materialRequest.current?.signal);
    }
  }, [briefData?.state.status, detail, tableQuery, loadTables]);

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

  async function triggerBrief(force: boolean) {
    if (!detail || detail.status !== "ready") return;
    const { ticker, accession } = detail.filing;
    setBriefBusy(true);
    setError("");
    try {
      const res = await adminApi<MaterialBriefResponse | { state: MaterialBriefResponse["state"] }>(
        `library/materials/${ticker}/${accession}/brief`,
        { method: "POST", body: JSON.stringify({ version: detail.ref.version, force }) },
      );
      if ("brief" in res) setBriefData(res);
      else setBriefData(prev => ({ state: res.state, brief: force ? null : prev?.brief ?? null, markdown: force ? null : prev?.markdown ?? null }));
    } catch (e) {
      fail(e);
    } finally {
      setBriefBusy(false);
    }
  }

  function downloadBrief(kind: "json" | "md") {
    if (!briefData?.brief || !detail || detail.status !== "ready") return;
    const content = kind === "json" ? JSON.stringify(briefData.brief, null, 2) : (briefData.markdown ?? "");
    const mime = kind === "json" ? "application/json;charset=utf-8" : "text/markdown;charset=utf-8";
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${detail.filing.ticker}-${detail.filing.accession}-brief.${kind}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function jumpToSource(sourceId: string) {
    if (!detail || detail.status !== "ready") return;
    const base = baseSourceId(sourceId);
    const isTable = snapshot?.tables.some(t => t.tableId === base) || tablesList.some(t => t.tableId === base);
    if (isTable) {
      setTab("tables");
      setSelectedTableId(base);
      return;
    }
    setTab("markdown");
    const signal = materialRequest.current?.signal;
    if (signal) void loadMarkdown(detail, signal, undefined, base);
  }

  const hasSelectedDetail = detail !== null && materialKey(detail) === selectedKey;
  const currentMaterial = hasSelectedDetail ? detail : selectedMaterial;
  const reportPage = hasSelectedDetail ? mdPage : null;
  const currentSnapshot = hasSelectedDetail ? snapshot : null;
  const tableDetail = hasSelectedDetail && detail.status === "ready"
    && loadedTable?.ref.version === detail.ref.version && loadedTable.table.tableId === selectedTableId
    ? loadedTable : null;
  const copiedCsv = tableDetail !== null && copiedTable === tableDetail;

  const groupedToc = useMemo(() => {
    const items = currentSnapshot?.toc ?? [];
    const groups: Array<{ kind: "primary" | "exhibit" | "technical"; items: typeof items }> = [
      { kind: "primary", items: [] },
      { kind: "exhibit", items: [] },
      { kind: "technical", items: [] },
    ];
    for (const item of items) {
      const kind = item.kind ?? (item.title === "Technical & Submission Originals" ? "technical" : "primary");
      groups.find(g => g.kind === kind)!.items.push(item);
    }
    return groups.filter(g => g.items.length > 0);
  }, [currentSnapshot?.toc]);

  const relatedCatalogEntry = useMemo(() => {
    if (!tableDetail || !briefData?.brief) return null;
    return briefData.brief.tableCatalog.find(entry => entry.tableId === tableDetail.table.tableId) ?? null;
  }, [tableDetail, briefData?.brief]);

  function copyCsv() {
    if (!tableDetail?.csv) return;
    void navigator.clipboard?.writeText(tableDetail.csv).then(() => {
      setCopiedTable(tableDetail);
      setTimeout(() => setCopiedTable(copied => copied === tableDetail ? null : copied), 1500);
    });
  }

  const renderCitations = (ids: string[]) => ids.length ? (
    <span className="fm2-cite-list">
      {ids.map(id => (
        <button key={id} type="button" className="fm2-cite-btn" title={`跳转到 L1 来源 ${id}`} onClick={() => jumpToSource(id)}>
          {id}
        </button>
      ))}
    </span>
  ) : null;

  const briefState = briefData?.state ?? { status: "idle" as const };

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

      <section className="ra-detail" aria-label="L1/L2 财报材料检查区">
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
                <span>申报类型：<strong>{currentMaterial.filing.form}</strong></span>
                <span>报告期：<strong>{currentMaterial.filing.reportDate || "—"}</strong></span>
                <span>提交日：<strong>{currentMaterial.filing.filedAt || "—"}</strong></span>
              </div>
            </div>

            <nav className="bs-views" aria-label="L1/L2 材料层级切换">
              <button type="button" aria-pressed={tab === "brief"} onClick={() => setTab("brief")}>L2 事实卡片</button>
              <button type="button" aria-pressed={tab === "markdown"} onClick={() => setTab("markdown")}>L1 原文 Markdown</button>
              <button type="button" aria-pressed={tab === "tables"} onClick={() => setTab("tables")}>L1 数据表格{currentSnapshot ? ` (${currentSnapshot.tables.length})` : ""}</button>
            </nav>

            {actionNote && <div className="fm2-badge ready">{actionNote}</div>}

            {tab === "brief" && (
              <div className="fm2-panel">
                {currentMaterial.status !== "ready" ? (
                  <div className="fm2-card">
                    <p className="fm2-meta">L1 原始材料尚未就绪，需先完成 L1 提取后才能启动 L2 事实卡片抽取。</p>
                    {currentMaterial.status === "preparing" && <p className="fm2-meta" role="status">{currentMaterial.progress}</p>}
                    {currentMaterial.status === "blocked" && (
                      <ul>{currentMaterial.issues.map((issue, idx) => <li key={idx}>{issue}</li>)}</ul>
                    )}
                    <div className="fm2-actions">
                      <button type="button" className="fm2-btn" disabled={actionBusy} onClick={() => void triggerPrepare(false)}>重新整理 L1 材料</button>
                      {currentMaterial.status === "blocked" && (
                        <button type="button" className="fm2-btn" disabled={actionBusy} onClick={() => void triggerPrepare(true)}>重试失败文件</button>
                      )}
                      <button type="button" className="fm2-btn" disabled={actionBusy} onClick={() => void triggerPilotPrepare()}>分批整理 L1</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="fm2-bar">
                      <div className="fm2-meta">
                        <span className={`fm2-badge ${briefState.status === "ready" ? "ready" : briefState.status === "running" ? "preparing" : briefState.status === "failed" ? "blocked" : ""}`}>
                          L2 状态：{BRIEF_STATUS_LABEL[briefState.status]}
                        </span>
                        {briefState.status === "running" && <span>Run: <code>{briefState.runId}</code> · 模型 {briefState.model}</span>}
                        {briefState.status === "ready" && (
                          <>
                            <span>模型：<strong>{briefState.model}</strong></span>
                            <span>指标 {briefState.metricsCount} · 信号 {briefState.signalsCount} · 表格描述 {briefState.tablesDescribed}</span>
                            {briefState.inputTokens !== undefined && <span>Tokens：{briefState.inputTokens.toLocaleString()} / {briefState.outputTokens?.toLocaleString() ?? "—"}</span>}
                            {briefState.durationMs !== undefined && <span>耗时 {(briefState.durationMs / 1000).toFixed(1)}s</span>}
                          </>
                        )}
                      </div>
                      <div className="fm2-actions">
                        <button
                          type="button"
                          className="fm2-btn primary"
                          disabled={briefBusy || briefState.status === "running"}
                          onClick={() => void triggerBrief(briefState.status === "ready")}
                        >
                          {briefState.status === "running" ? "L2 抽取中…" : briefState.status === "ready" ? "重新生成 L2" : "启动 L2 抽取"}
                        </button>
                        {briefData?.brief && (
                          <>
                            <button type="button" className="fm2-btn" onClick={() => downloadBrief("md")}>下载 brief.md</button>
                            <button type="button" className="fm2-btn" onClick={() => downloadBrief("json")}>下载 brief.json</button>
                          </>
                        )}
                      </div>
                    </div>

                    {briefState.status === "failed" && (
                      <div className="fm2-card">
                        <strong>L2 抽取失败</strong>
                        <p className="fm2-meta">{briefState.error}</p>
                      </div>
                    )}

                    {briefData?.brief ? (
                      <>
                        <div className="fm2-filters" role="group" aria-label="L2 视图模式">
                          <button type="button" className="fm2-filter-pill" aria-pressed={briefView === "structured"} onClick={() => setBriefView("structured")}>结构化核对视图</button>
                          <button type="button" className="fm2-filter-pill" aria-pressed={briefView === "markdown"} onClick={() => setBriefView("markdown")}>brief.md</button>
                          <button type="button" className="fm2-filter-pill" aria-pressed={briefView === "json"} onClick={() => setBriefView("json")}>brief.json</button>
                        </div>

                        {briefView === "structured" && (
                          <div className="fm2-brief-stack">
                            <div className="fm2-brief-section">
                              <h3>披露元数据 & 核心主线（点击右侧编号直接跳转 L1 原文或 CSV）</h3>
                              <div className="fm2-meta" style={{ marginBottom: 8 }}>
                                <span>覆盖期末：<strong>{briefData.brief.disclosureMeta.coveredPeriodEnd ?? "—"}</strong></span>
                                <span>财季：<strong>{briefData.brief.disclosureMeta.fiscalPeriod ?? "—"}</strong></span>
                                <span>类型：<strong>{briefData.brief.disclosureMeta.disclosureKind}</strong></span>
                                <span>货币：<strong>{briefData.brief.disclosureMeta.currency ?? "—"}</strong></span>
                                {briefData.brief.invalidSourceIdsDropped > 0 && (
                                  <span>已剔除无效引用：{briefData.brief.invalidSourceIdsDropped}</span>
                                )}
                              </div>
                              <p style={{ margin: "0 0 8px", fontWeight: 600, fontSize: 14 }}>{briefData.brief.headline}</p>
                              <ul className="fm2-brief-list">
                                {briefData.brief.keyTakeaways.map((item, idx) => (
                                  <li key={idx}>{item.text}{renderCitations(item.sourceIds)}</li>
                                ))}
                              </ul>
                            </div>

                            {briefData.brief.metrics.length > 0 && (
                              <div className="fm2-brief-section">
                                <h3>标准化财务与分部指标 ({briefData.brief.metrics.length})</h3>
                                <div className="fm2-table-wrap">
                                  <table className="fm2-table">
                                    <thead>
                                      <tr>
                                        <th>指标</th><th>分部</th><th>报告期</th><th>标准期</th><th>数值</th><th>口径</th><th>YoY</th><th>QoQ</th><th>L1 溯源</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {briefData.brief.metrics.map((m, idx) => (
                                        <tr key={idx}>
                                          <td><strong>{m.name}</strong>{m.note ? <div className="fm2-meta">{m.note}</div> : null}</td>
                                          <td>{m.segment ?? "—"}</td>
                                          <td>{m.period}</td>
                                          <td>{m.calendarPeriod ?? "—"}</td>
                                          <td>{m.unit ? `${m.value} (${m.unit})` : m.value}</td>
                                          <td>{m.basis}</td>
                                          <td>{m.yoy ?? "—"}</td>
                                          <td>{m.qoq ?? "—"}</td>
                                          <td>{renderCitations(m.sourceIds)}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            )}

                            {briefData.brief.guidanceAndChanges.length > 0 && (
                              <div className="fm2-brief-section">
                                <h3>业绩指引、CapEx 与口径变更 ({briefData.brief.guidanceAndChanges.length})</h3>
                                <ul className="fm2-brief-list">
                                  {briefData.brief.guidanceAndChanges.map((item, idx) => (
                                    <li key={idx}>
                                      <strong>{item.topic}</strong>：{item.summary}
                                      {item.quantitativeTerms ? `（${item.quantitativeTerms}）` : ""}
                                      {renderCitations(item.sourceIds)}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}

                            {briefData.brief.risksAndFootnotes.length > 0 && (
                              <div className="fm2-brief-section">
                                <h3>附注风险与表外条款 ({briefData.brief.risksAndFootnotes.length})</h3>
                                <ul className="fm2-brief-list">
                                  {briefData.brief.risksAndFootnotes.map((item, idx) => (
                                    <li key={idx}>
                                      <strong>{item.topic}</strong>：{item.summary}
                                      {item.quantitativeTerms ? `（${item.quantitativeTerms}）` : ""}
                                      {renderCitations(item.sourceIds)}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}

                            {briefData.brief.industrySignals.length > 0 && (
                              <div className="fm2-brief-section">
                                <h3>行业横向信号 ({briefData.brief.industrySignals.length})</h3>
                                <ul className="fm2-brief-list">
                                  {briefData.brief.industrySignals.map((item, idx) => (
                                    <li key={idx}>
                                      <span className="fm2-badge" style={{ marginRight: 6 }}>{item.dimension} · {item.stance}</span>
                                      {item.summary}
                                      {renderCitations(item.sourceIds)}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        )}

                        {briefView === "markdown" && (
                          <div className="fm2-content fm2-report-scroll">
                            <Suspense fallback={<p className="bs-empty" role="status">正在渲染 brief.md…</p>}>
                              <FilingMarkdown text={briefData.markdown ?? ""} />
                            </Suspense>
                          </div>
                        )}

                        {briefView === "json" && (
                          <pre className="fm2-pre">{JSON.stringify(briefData.brief, null, 2)}</pre>
                        )}
                      </>
                    ) : briefState.status === "idle" ? (
                      <div className="fm2-card">
                        <strong>尚未生成 L2 事实卡片</strong>
                        <p className="fm2-meta">点击右上角「启动 L2 抽取」，将整份 L1 财报（主报 + 附件 + 表格）一次性送入 DeepSeek 生成标准化 L2 卡片并回填表格目录。</p>
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            )}

            {tab === "markdown" && (
              <div className="fm2-panel">
                {currentMaterial.status !== "ready" ? (
                  <div className="fm2-card">
                    {currentMaterial.status === "preparing" && <p className="fm2-meta" role="status">{currentMaterial.progress}</p>}
                    {currentMaterial.status === "blocked" && (
                      <ul>{currentMaterial.issues.map((issue, idx) => <li key={idx}>{issue}</li>)}</ul>
                    )}
                    <div className="fm2-actions">
                      <button type="button" className="fm2-btn" disabled={actionBusy} onClick={() => void triggerPrepare(false)}>重新整理材料</button>
                      {currentMaterial.status === "blocked" && (
                        <button type="button" className="fm2-btn" disabled={actionBusy} onClick={() => void triggerPrepare(true)}>重试失败文件</button>
                      )}
                      <button type="button" className="fm2-btn" disabled={actionBusy} onClick={() => void triggerPilotPrepare()}>分批整理材料</button>
                    </div>
                  </div>
                ) : (
                  <>
                    {currentSnapshot && (
                      <div className="fm2-bar">
                        <div className="fm2-meta">
                          <span>文档 {currentSnapshot.coverage.archivedDocuments}/{currentSnapshot.coverage.expectedDocuments}</span>
                          <span>块 {currentSnapshot.coverage.retainedBlocks}/{currentSnapshot.coverage.sourceBlocks}</span>
                          <span>表格单元格 {currentSnapshot.coverage.checkedCells}/{currentSnapshot.coverage.tableCells}</span>
                          <span>正文总长 {formatChars(currentSnapshot.markdown.chars)}</span>
                          {activeAnchor && <span>当前定位：<code>{activeAnchor}</code></span>}
                        </div>
                        {activeAnchor && (
                          <button type="button" className="fm2-btn" onClick={() => {
                            const signal = materialRequest.current?.signal;
                            if (signal) void loadMarkdown(currentMaterial, signal);
                          }}>回到开头</button>
                        )}
                      </div>
                    )}
                    <div className="fm2-split">
                      <aside className="fm2-toc" aria-label="L1 原生目录">
                        {groupedToc.map(group => (
                          <div key={group.kind}>
                            <div className="fm2-toc-group">{TOC_GROUP_LABEL[group.kind]}</div>
                            {group.items.map(item => (
                              <button
                                key={item.anchor}
                                type="button"
                                className="fm2-toc-btn"
                                aria-pressed={activeAnchor === item.anchor}
                                onClick={() => {
                                  const signal = materialRequest.current?.signal;
                                  if (signal) void loadMarkdown(currentMaterial, signal, undefined, item.anchor);
                                }}
                              >
                                <div>{item.title}</div>
                                <small>{formatChars(item.chars)}</small>
                              </button>
                            ))}
                          </div>
                        ))}
                      </aside>
                      <div ref={mdScrollRef} className="fm2-content fm2-report-scroll">
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
                    </div>
                  </>
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
                        <p className="bs-empty" role="status">{tablesList.length ? "加载表格内容中…" : "未提取到匹配表格"}</p>
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
                          {tableDetail.table.description && (
                            <p className="fm2-meta" style={{ marginTop: 0 }}>
                              {tableDetail.table.description}
                              {relatedCatalogEntry?.relatedSourceIds.length ? renderCitations(relatedCatalogEntry.relatedSourceIds) : null}
                            </p>
                          )}
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
