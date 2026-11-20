import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowsClockwiseIcon as RefreshCw, CheckIcon as Check, CopyIcon as Copy, MagnifyingGlassIcon as Search, XIcon as X } from "@phosphor-icons/react";
import type { MaterialPage, MaterialSnapshot, MaterialState, MaterialTable } from "@/shared/analysis-contract/filing-material";
import { CompanyLogo } from "@/packages/web/src/company-logo";
import { adminApi, AdminApiError } from "./admin-api";
import { usePageActive } from "./admin-page";
import "./filing-materials.css";

type Props = { onAuthenticated: () => void; onUnauthorized: () => void };
type Tab = "markdown" | "tables" | "approval";
type FilterKind = "all" | "pending" | "approved" | "rejected" | "blocked";
type MaterialReview = { decision: "approved" | "rejected"; version: string | null; note?: string; reviewedAt: string };
type MaterialItem = MaterialState & { review?: MaterialReview | null };
type MaterialDetail = MaterialItem & {
  pilot?: { mode?: string; requestId?: string; chunkStatus?: string; repairSource?: string; repairRequestId?: string; reconciliation?: unknown };
  resumeRequired?: boolean;
};
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

export function FilingMaterials({ onAuthenticated, onUnauthorized }: Props) {
  const [materials, setMaterials] = useState<MaterialItem[] | null>(null);
  const [search, setSearch] = useState("");
  const [filterKind, setFilterKind] = useState<FilterKind>("all");
  const [selectedKey, setSelectedKey] = useState<string>("");
  const [tab, setTab] = useState<Tab>("markdown");
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");

  const [detail, setDetail] = useState<MaterialDetail | null>(null);
  const [snapshot, setSnapshot] = useState<MaterialSnapshot | null>(null);
  const [mdPage, setMdPage] = useState<MaterialPage | null>(null);
  const [activeAnchor, setActiveAnchor] = useState<string>("");
  const [mdLoading, setMdLoading] = useState(false);

  const [tableQuery, setTableQuery] = useState("");
  const [tablesList, setTablesList] = useState<MaterialTable[]>([]);
  const [tablesCursor, setTablesCursor] = useState<string | null>(null);
  const [selectedTableId, setSelectedTableId] = useState<string>("");
  const [tableDetail, setTableDetail] = useState<TableReadResponse | null>(null);
  const [copiedCsv, setCopiedCsv] = useState(false);

  const [reviewNote, setReviewNote] = useState("");
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
    void adminApi<{ materials: MaterialItem[] }>("library", { signal: c.signal }).then(res => {
      const sorted = [...res.materials].sort((a, b) => (b.filing.filedAt || "").localeCompare(a.filing.filedAt || ""));
      setMaterials(sorted);
      setError("");
      callbacks.current.onAuthenticated();
      setSelectedKey(prev => (prev && sorted.some(m => materialKey(m) === prev)) ? prev : (sorted[0] ? materialKey(sorted[0]) : ""));
    }).catch(e => { if (!c.signal.aborted) fail(e); });
    return () => c.abort();
  }, [refresh, fail]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (materials ?? []).filter(m => {
      const rev = m.review?.decision;
      if (filterKind === "pending" && rev) return false;
      if (filterKind === "approved" && rev !== "approved") return false;
      if (filterKind === "rejected" && rev !== "rejected") return false;
      if (filterKind === "blocked" && m.status !== "blocked") return false;
      if (!q) return true;
      return `${m.filing.ticker} ${m.filing.companyName} ${m.filing.form} ${m.filing.accession} ${m.filing.reportDate}`.toLowerCase().includes(q);
    });
  }, [materials, search, filterKind]);

  const selectedMaterial = useMemo(
    () => (materials ?? []).find(m => materialKey(m) === selectedKey) ?? null,
    [materials, selectedKey]
  );

  const loadMarkdown = useCallback(async (ticker: string, accession: string, opts: { anchor?: string; cursor?: string } = {}) => {
    setMdLoading(true);
    try {
      const params = new URLSearchParams();
      if (opts.anchor) params.set("anchor", opts.anchor);
      if (opts.cursor) params.set("cursor", opts.cursor);
      const qs = params.toString();
      const page = await adminApi<MaterialPage>(`library/materials/${ticker}/${accession}/markdown${qs ? `?${qs}` : ""}`);
      setMdPage(page);
      setActiveAnchor(opts.anchor ?? "");
    } catch (e) {
      fail(e);
    } finally {
      setMdLoading(false);
    }
  }, [fail]);

  const loadTables = useCallback(async (ticker: string, accession: string, name = "", cursor = "") => {
    try {
      const params = new URLSearchParams();
      if (name.trim()) params.set("name", name.trim());
      if (cursor) params.set("cursor", cursor);
      const qs = params.toString();
      const res = await adminApi<{ tables: MaterialTable[]; nextCursor: string | null }>(`library/materials/${ticker}/${accession}/tables${qs ? `?${qs}` : ""}`);
      setTablesList(prev => cursor ? [...prev, ...res.tables] : res.tables);
      setTablesCursor(res.nextCursor);
      if (!cursor && res.tables[0]) setSelectedTableId(res.tables[0].tableId);
      else if (!cursor) { setSelectedTableId(""); setTableDetail(null); }
    } catch (e) {
      fail(e);
    }
  }, [fail]);

  const loadTableDetail = useCallback(async (ticker: string, accession: string, tableId: string, cursor = "") => {
    if (!tableId) return;
    try {
      const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const res = await adminApi<TableReadResponse>(`library/materials/${ticker}/${accession}/tables/${encodeURIComponent(tableId)}${qs}`);
      setTableDetail(res);
    } catch (e) {
      fail(e);
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
    setReviewNote(selectedMaterial.review?.note ?? "");
    setDetail(null);
    setSnapshot(null);
    setMdPage(null);
    setTablesList([]);
    setTableDetail(null);
    const c = new AbortController();

    void adminApi<MaterialDetail>(`library/materials/${ticker}/${accession}`, { signal: c.signal })
      .then(d => {
        setDetail(d);
        if (d.review?.note !== undefined) setReviewNote(d.review.note);
        if (d.status === "ready") {
          void adminApi<MaterialSnapshot>(`library/materials/${ticker}/${accession}/index`, { signal: c.signal })
            .then(idx => setSnapshot(idx))
            .catch(e => { if (!c.signal.aborted) fail(e); });
          void loadMarkdown(ticker, accession);
          void loadTables(ticker, accession);
        }
      })
      .catch(e => { if (!c.signal.aborted) fail(e); });

    return () => c.abort();
  }, [selectedMaterial, fail, loadMarkdown, loadTables]);

  useEffect(() => {
    if (!selectedMaterial || !selectedTableId || tab !== "tables") return;
    void loadTableDetail(selectedMaterial.filing.ticker, selectedMaterial.filing.accession, selectedTableId);
  }, [selectedMaterial, selectedTableId, tab, loadTableDetail]);

  useEffect(() => {
    if (!selectedMaterial || !visible.current) return;
    try {
      window.history.replaceState(null, "", `${window.location.pathname}?${new URLSearchParams({ ticker: selectedMaterial.filing.ticker, accession: selectedMaterial.filing.accession })}`);
    } catch { /* ignore */ }
  }, [selectedMaterial, visible]);

  async function submitReview(decision: "approved" | "rejected") {
    if (!selectedMaterial) return;
    const { ticker, accession } = selectedMaterial.filing;
    setActionBusy(true);
    setActionNote("");
    try {
      const res = await adminApi<{ status: string; review: MaterialReview }>(`library/materials/${ticker}/${accession}/review`, {
        method: "POST",
        body: JSON.stringify({ decision, note: reviewNote.trim() }),
      });
      setDetail(prev => prev ? { ...prev, review: res.review } : prev);
      setMaterials(prev => prev ? prev.map(m => materialKey(m) === selectedKey ? { ...m, review: res.review } : m) : prev);
      setActionNote(decision === "approved" ? "已审批通过该财报材料。" : "已标记驳回该财报材料。");
    } catch (e) {
      fail(e);
    } finally {
      setActionBusy(false);
    }
  }

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
      setActionNote(retryFailedSources ? "已提交失败源重试请求。" : "已重新提交财报材料整理任务。");
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
      setActionNote("已提交 Pilot 分块整理任务。");
      setRefresh(n => n + 1);
    } catch (e) {
      fail(e);
    } finally {
      setActionBusy(false);
    }
  }

  function copyCsv() {
    if (!tableDetail?.csv) return;
    void navigator.clipboard?.writeText(tableDetail.csv).then(() => {
      setCopiedCsv(true);
      setTimeout(() => setCopiedCsv(false), 1500);
    });
  }

  const currentReview = detail?.review ?? selectedMaterial?.review ?? null;

  return (
    <div className="ra-workspace fm2-workspace">
      <section className="ra-list" aria-label="财报材料列表">
        <div className="ra-filters">
          <label className="ra-search">
            <Search size={17} />
            <input aria-label="搜索财报材料" placeholder="代码 / 表格类型 / Accession" value={search} onChange={e => setSearch(e.target.value)} />
          </label>
          <button className="bs-icon" aria-label="刷新" onClick={() => setRefresh(n => n + 1)}>
            <RefreshCw size={17} />
          </button>
        </div>
        <div className="fm2-filters" role="group" aria-label="按审批与状态筛选">
          {([["all", "全部"], ["pending", "待审批"], ["approved", "已通过"], ["rejected", "已驳回"], ["blocked", "已阻塞"]] as const).map(([val, label]) => (
            <button key={val} type="button" className="fm2-filter-pill" aria-pressed={filterKind === val} onClick={() => setFilterKind(val)}>
              {label}
            </button>
          ))}
        </div>
        <div className="ra-list-caption">{materials ? `${filtered.length} / ${materials.length} 份材料` : "加载中"}</div>
        {error && <p className="ra-error" role="alert">{error}</p>}
        <div className="ra-list-scroll">
          {filtered.map(m => {
            const key = materialKey(m);
            const rev = m.review?.decision;
            return (
              <button key={key} type="button" className="ra-report-row" aria-pressed={selectedKey === key} onClick={() => setSelectedKey(key)}>
                <CompanyLogo symbol={m.filing.ticker} />
                <span className="ra-row-info">
                  <strong>{m.filing.ticker} · {m.filing.form}</strong>
                  <small>
                    {m.filing.reportDate || m.filing.filedAt} · <span className={`fm2-badge ${m.status}`}>{STATUS_LABEL[m.status]}</span>{" "}
                    <span className={`fm2-badge ${rev ?? "pending"}`}>{rev === "approved" ? "已通过" : rev === "rejected" ? "已驳回" : "待审批"}</span>
                  </small>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="ra-detail" aria-label="财报整理内容与审批">
        {!selectedMaterial ? (
          <p className="bs-empty">请从左侧选择一份财报材料查看 Markdown 文稿、数据表格并进行审批。</p>
        ) : (
          <>
            <div className="fm2-head">
              <div className="fm2-title">
                <h2>{selectedMaterial.filing.ticker} · {selectedMaterial.filing.companyName}</h2>
                <span className={`fm2-badge ${selectedMaterial.status}`}>{STATUS_LABEL[selectedMaterial.status]}</span>
                <span className={`fm2-badge ${currentReview?.decision ?? "pending"}`}>
                  {currentReview?.decision === "approved" ? "已审批通过" : currentReview?.decision === "rejected" ? "已驳回" : "待审批"}
                </span>
                {detail?.pilot?.mode && <span className="fm2-badge preparing">Pilot: {detail.pilot.chunkStatus ?? detail.pilot.mode}</span>}
              </div>
              <div className="fm2-meta">
                <span>表格类型：<strong>{selectedMaterial.filing.form}</strong></span>
                <span>报告期：<strong>{selectedMaterial.filing.reportDate || "—"}</strong></span>
                <span>申报日：<strong>{selectedMaterial.filing.filedAt}</strong></span>
                <span>Accession：<code>{selectedMaterial.filing.accession}</code></span>
              </div>
            </div>

            <div className="fm2-review-bar" role="region" aria-label="材料快捷审批栏">
              <div className="fm2-meta">
                <span>
                  审批状态：
                  <strong>{currentReview ? `${currentReview.decision === "approved" ? "通过" : "驳回"} (${currentReview.reviewedAt.slice(0, 19).replace("T", " ")})` : "尚未审批"}</strong>
                </span>
                {snapshot && (
                  <>
                    <span>文档：<strong>{snapshot.coverage.archivedDocuments}/{snapshot.coverage.expectedDocuments}</strong></span>
                    <span>内容块：<strong>{snapshot.coverage.retainedBlocks}/{snapshot.coverage.sourceBlocks}</strong></span>
                    <span>表格：<strong>{snapshot.tables.length} 张 ({snapshot.coverage.checkedCells}/{snapshot.coverage.tableCells} 格)</strong></span>
                    <span>问题：<strong>{snapshot.coverage.issues.length}</strong></span>
                  </>
                )}
              </div>
              <div className="fm2-actions">
                <input
                  className="fm2-review-input"
                  aria-label="审批备注"
                  placeholder="填写审批备注（可选）"
                  value={reviewNote}
                  onChange={e => setReviewNote(e.target.value)}
                />
                <button type="button" className="fm2-btn primary" disabled={actionBusy} onClick={() => void submitReview("approved")}>
                  <Check size={14} /> 审批通过
                </button>
                <button type="button" className="fm2-btn danger" disabled={actionBusy} onClick={() => void submitReview("rejected")}>
                  <X size={14} /> 驳回
                </button>
              </div>
            </div>

            <nav className="bs-views" aria-label="财报材料视图">
              <button type="button" aria-pressed={tab === "markdown"} onClick={() => setTab("markdown")}>Markdown 文稿</button>
              <button type="button" aria-pressed={tab === "tables"} onClick={() => setTab("tables")}>数据表格{snapshot ? ` (${snapshot.tables.length})` : ""}</button>
              <button type="button" aria-pressed={tab === "approval"} onClick={() => setTab("approval")}>材料诊断与重整</button>
            </nav>

            {actionNote && <div className="fm2-badge ready">{actionNote}</div>}

            {tab === "markdown" && (
              <div className="fm2-panel">
                {selectedMaterial.status !== "ready" ? (
                  <p className="bs-empty">当前材料状态为「{STATUS_LABEL[selectedMaterial.status]}」，尚未生成可读 Markdown。请切换到「材料诊断与重整」查看详情或重新触发整理。</p>
                ) : (
                  <div className="fm2-split">
                    <aside className="fm2-toc" aria-label="文稿目录">
                      <button type="button" className="fm2-toc-btn" aria-pressed={!activeAnchor} onClick={() => void loadMarkdown(selectedMaterial.filing.ticker, selectedMaterial.filing.accession)}>
                        从开头阅读
                      </button>
                      {(mdPage?.toc ?? snapshot?.toc ?? []).map(item => (
                        <button key={item.anchor} type="button" className="fm2-toc-btn" aria-pressed={activeAnchor === item.anchor} onClick={() => void loadMarkdown(selectedMaterial.filing.ticker, selectedMaterial.filing.accession, { anchor: item.anchor })}>
                          {item.title}
                        </button>
                      ))}
                    </aside>
                    <div className="fm2-content">
                      <div className="fm2-bar">
                        <span className="fm2-meta">
                          {mdLoading ? "读取中…" : `已加载 ${mdPage?.text.length ?? 0} 字符`}
                          {mdPage?.blockIds.length ? ` · ${mdPage.blockIds.length} 个内容块` : ""}
                        </span>
                        <div className="fm2-actions">
                          {mdPage?.nextCursor && (
                            <button type="button" className="fm2-btn" disabled={mdLoading} onClick={() => void loadMarkdown(selectedMaterial.filing.ticker, selectedMaterial.filing.accession, { cursor: mdPage.nextCursor! })}>
                              加载下一段
                            </button>
                          )}
                        </div>
                      </div>
                      <pre className="fm2-md-pre">{mdPage?.text || (mdLoading ? "加载文稿中…" : "暂无文本内容")}</pre>
                    </div>
                  </div>
                )}
              </div>
            )}

            {tab === "tables" && (
              <div className="fm2-panel">
                {selectedMaterial.status !== "ready" ? (
                  <p className="bs-empty">当前材料状态为「{STATUS_LABEL[selectedMaterial.status]}」，尚未生成结构化表格。</p>
                ) : (
                  <div className="fm2-split">
                    <aside className="fm2-toc" aria-label="表格列表">
                      <form onSubmit={e => { e.preventDefault(); void loadTables(selectedMaterial.filing.ticker, selectedMaterial.filing.accession, tableQuery); }} style={{ marginBottom: 8 }}>
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
                        <button type="button" className="fm2-btn" style={{ width: "100%", marginTop: 8 }} onClick={() => void loadTables(selectedMaterial.filing.ticker, selectedMaterial.filing.accession, tableQuery, tablesCursor)}>
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

            {tab === "approval" && (
              <div className="fm2-panel">
                <div className="fm2-card">
                  <h3>材料状态与重新整理</h3>
                  <div className="fm2-meta">
                    <span>状态：<strong>{STATUS_LABEL[selectedMaterial.status]}</strong></span>
                    {selectedMaterial.status === "preparing" && <span>进度：{selectedMaterial.progress}</span>}
                    {selectedMaterial.status === "ready" && <span>完成时间：{selectedMaterial.preparedAt} · 版本：{selectedMaterial.preparationVersion}</span>}
                  </div>
                  {selectedMaterial.status === "blocked" && (
                    <div>
                      <strong>阻塞原因：</strong>
                      <ul>{selectedMaterial.issues.map((issue, idx) => <li key={idx}>{issue}</li>)}</ul>
                    </div>
                  )}
                  {snapshot && snapshot.coverage.issues.length > 0 && (
                    <div>
                      <strong>覆盖度提示：</strong>
                      <ul>{snapshot.coverage.issues.map((issue, idx) => <li key={idx}>{issue}</li>)}</ul>
                    </div>
                  )}
                  <div className="fm2-actions">
                    <button type="button" className="fm2-btn primary" disabled={actionBusy} onClick={() => void triggerPrepare(false)}>
                      重新整理材料 (Prepare)
                    </button>
                    {selectedMaterial.status === "blocked" && (
                      <button type="button" className="fm2-btn" disabled={actionBusy} onClick={() => void triggerPrepare(true)}>
                        重试失败源 (Retry Failed)
                      </button>
                    )}
                    {selectedMaterial.status !== "ready" && (
                      <button type="button" className="fm2-btn" disabled={actionBusy} onClick={() => void triggerPilotPrepare()}>
                        启动 Pilot 分块整理
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
