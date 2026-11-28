import { Fragment, useMemo, useState } from "react";
import { MagnifyingGlassIcon as Search } from "@phosphor-icons/react";
import rawDataset from "@/benchmarks/filing-analysis-benchmark.json";
import "./report-benchmark.css";

type VetoRule = { id: string; name: string; description: string };
type DimensionDef = { id: string; name: string; max: number };
type SubItemDef = { id: string; dimension: string; name: string; max: number };

type VetoCheck = { pass: boolean; note?: string };
type SubItemScore = {
  id: string;
  name?: string;
  score: number;
  max?: number;
  delta?: number | null;
  rootCause?: string | null;
  evidence?: string;
};
type NegativeFeedbackItem = {
  priority: number;
  rootCause: string;
  targetSubItems?: string[];
  suggestion: string;
  targetFiles?: string[];
};
type BenchmarkVersion = {
  versionId: string;
  versionNumber: number;
  isBaseline?: boolean;
  createdAt: string;
  goal: string;
  gitCommit?: string;
  generatorModel?: string;
  judgeModel?: string;
  rawArticle: { format: "markdown" | "html" | "text"; content: string };
  veto: { triggered: boolean; v1?: VetoCheck; v2?: VetoCheck; v3?: VetoCheck };
  totalScore: number;
  grade: "S" | "A" | "B" | "C" | string;
  deltaFromPrev?: number | null;
  dimensions?: Record<string, { score: number; max: number }>;
  subItems: SubItemScore[];
  negativeFeedback?: NegativeFeedbackItem[];
  pairwiseVsPrev?: { outcome: "WIN" | "TIE" | "LOSS" | string; summary?: string } | null;
};
type BenchmarkEntry = {
  benchmarkKey: string;
  ticker: string;
  form: string;
  periodEnd: string;
  title?: string;
  versions: BenchmarkVersion[];
};
type BenchmarkDataset = {
  schemaVersion: string;
  rubricVersion: string;
  rubric: {
    vetoRules: VetoRule[];
    dimensions: DimensionDef[];
    subItems: SubItemDef[];
  };
  benchmarks: BenchmarkEntry[];
};

type TabKey = "subitems" | "history" | "article" | "feedback";

const DATASET = rawDataset as unknown as BenchmarkDataset;

function formatDelta(delta: number | null | undefined): { text: string; cls: "up" | "down" | "flat" } {
  if (delta == null || Number.isNaN(delta)) return { text: "—", cls: "flat" };
  if (delta > 0) return { text: `+${delta}`, cls: "up" };
  if (delta < 0) return { text: `${delta}`, cls: "down" };
  return { text: "0", cls: "flat" };
}

function gradeStatus(grade: string, vetoTriggered: boolean): string {
  if (vetoTriggered || grade === "C") return "failed";
  if (grade === "S" || grade === "A") return "reviewed";
  return "caution";
}

function ArticleView({ version }: { version: BenchmarkVersion }) {
  if (version.rawArticle.format === "html") {
    return (
      <iframe
        className="rb-article-frame"
        sandbox=""
        title={`${version.versionId} 原始文章`}
        srcDoc={version.rawArticle.content}
      />
    );
  }
  return <pre className="rb-article-pre">{version.rawArticle.content || "（该版本未附带原始文章正文）"}</pre>;
}

/**
 * SEC filing analysis benchmark & history version viewer.
 * Reads directly from `benchmarks/filing-analysis-benchmark.json` so Codex/agents can append
 * new baseline & optimization versions cleanly under version control.
 */
export function ReportBenchmark() {
  const { rubric, benchmarks } = DATASET;
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string>(() => benchmarks[0]?.benchmarkKey ?? "");
  const [selectedVersionId, setSelectedVersionId] = useState<string>("");
  const [compareVersionId, setCompareVersionId] = useState<string>("auto");
  const [tab, setTab] = useState<TabKey>("subitems");
  const [splitArticle, setSplitArticle] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return benchmarks;
    return benchmarks.filter(b =>
      b.benchmarkKey.toLowerCase().includes(q)
      || b.ticker.toLowerCase().includes(q)
      || b.form.toLowerCase().includes(q)
      || (b.title ?? "").toLowerCase().includes(q),
    );
  }, [benchmarks, query]);

  const activeEntry = useMemo(
    () => benchmarks.find(b => b.benchmarkKey === selectedKey) ?? filtered[0] ?? null,
    [benchmarks, filtered, selectedKey],
  );

  const versions = useMemo(
    () => activeEntry ? [...activeEntry.versions].sort((a, b) => a.versionNumber - b.versionNumber) : [],
    [activeEntry],
  );

  const activeVersion = useMemo(() => {
    if (!versions.length) return null;
    return versions.find(v => v.versionId === selectedVersionId) ?? versions[versions.length - 1];
  }, [versions, selectedVersionId]);

  const compareVersion = useMemo(() => {
    if (!activeVersion || versions.length < 2) return null;
    if (compareVersionId === "none") return null;
    if (compareVersionId !== "auto") {
      return versions.find(v => v.versionId === compareVersionId && v.versionId !== activeVersion.versionId) ?? null;
    }
    const idx = versions.findIndex(v => v.versionId === activeVersion.versionId);
    return idx > 0 ? versions[idx - 1] : null;
  }, [activeVersion, compareVersionId, versions]);

  const subItemMap = useMemo(() => {
    const map = new Map<string, SubItemScore>();
    for (const item of activeVersion?.subItems ?? []) map.set(item.id, item);
    return map;
  }, [activeVersion]);

  const compareSubItemMap = useMemo(() => {
    const map = new Map<string, SubItemScore>();
    for (const item of compareVersion?.subItems ?? []) map.set(item.id, item);
    return map;
  }, [compareVersion]);

  function computeDimensionScore(dimId: string, map: Map<string, SubItemScore>): number {
    return rubric.subItems
      .filter(s => s.dimension === dimId)
      .reduce((acc, s) => acc + (map.get(s.id)?.score ?? 0), 0);
  }

  function selectEntry(key: string) {
    setSelectedKey(key);
    setSelectedVersionId("");
    setCompareVersionId("auto");
  }

  return (
    <div className="ra-workspace rb-workspace">
      <aside className="ra-list" aria-label="评测标的列表">
        <div className="ra-filters">
          <label className="ra-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="筛选标的（如 CRWV 10-Q）"
              aria-label="筛选评测标的"
            />
          </label>
        </div>
        <div className="ra-list-caption">
          <span>{filtered.length} 个评测标的</span>
        </div>
        <div className="ra-list-scroll">
          {filtered.length === 0 ? (
            <p className="rb-empty-state">{benchmarks.length ? "没有匹配的标的" : "暂无评测记录"}</p>
          ) : (
            filtered.map(entry => {
              const sorted = [...entry.versions].sort((a, b) => a.versionNumber - b.versionNumber);
              const latest = sorted[sorted.length - 1];
              const prev = sorted.length > 1 ? sorted[sorted.length - 2] : null;
              const delta = latest && prev ? latest.totalScore - prev.totalScore : latest?.deltaFromPrev ?? null;
              const d = formatDelta(delta);
              const isSelected = activeEntry?.benchmarkKey === entry.benchmarkKey;
              return (
                <button
                  key={entry.benchmarkKey}
                  type="button"
                  className="ra-report-row"
                  aria-pressed={isSelected}
                  onClick={() => selectEntry(entry.benchmarkKey)}
                >
                  <div className="ra-row-info">
                    <strong>{entry.ticker}</strong>
                    <small>{latest ? `${latest.totalScore} 分` : "未打分"}</small>
                    <span>
                      {entry.form} · {entry.periodEnd} · {entry.versions.length} 版
                      {delta != null && <span className={`rb-delta ${d.cls}`} style={{ marginLeft: 6 }}>{d.text}</span>}
                    </span>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </aside>

      <section className="ra-detail" aria-label="报告评测详情">
        {!activeEntry || !activeVersion ? (
          <div className="rb-empty-guide">
            <header className="rb-empty-intro">
              <h1>暂无评测记录</h1>
              <p>完成报告质检后，将基线和迭代版本写入 <code>benchmarks/filing-analysis-benchmark.json</code>。</p>
              <details>
                <summary>记录字段与评分指引</summary>
                <p><code>docs/filing-analysis-eval-guide.md</code> 说明如何录入原文、分项得分和反馈。</p>
              </details>
            </header>

            <div>
              <div className="rb-title-row">
                <h2>评分红线</h2>
                <span className="rb-meta">触发任一项时总分上限为 59 分</span>
              </div>
              <div className="rb-table-wrap" role="region" aria-label="评分红线" tabIndex={0}>
                <table className="rb-table">
                  <thead>
                    <tr>
                      <th>编号</th>
                      <th>红线名称</th>
                      <th>判定标准</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rubric.vetoRules.map(rule => (
                      <tr key={rule.id}>
                        <td className="ra-mono">{rule.id}</td>
                        <td style={{ whiteSpace: "nowrap", fontWeight: 500 }}>{rule.name}</td>
                        <td className="rb-evidence">{rule.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <div className="rb-title-row">
                <h2>评分项目</h2>
                <span className="rb-meta">{rubric.subItems.length} 项 · 满分 100 分 · {DATASET.rubricVersion}</span>
              </div>
              <div className="rb-table-wrap" role="region" aria-label="评分项目" tabIndex={0}>
                <table className="rb-table">
                  <thead>
                    <tr>
                      <th>编号</th>
                      <th>小项名称</th>
                      <th style={{ textAlign: "right" }}>满分</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rubric.dimensions.map(dim => (
                      <Fragment key={dim.id}>
                        <tr className="rb-dim-divider">
                          <td colSpan={2}>{dim.id} · {dim.name}</td>
                          <td className="rb-num">{dim.max} 分</td>
                        </tr>
                        {rubric.subItems.filter(s => s.dimension === dim.id).map(sub => (
                          <tr key={sub.id}>
                            <td className="ra-mono">{sub.id}</td>
                            <td>{sub.name}</td>
                            <td className="rb-num">{sub.max}</td>
                          </tr>
                        ))}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ) : (
          <>
            <header className="rb-head">
              <div className="rb-title-group">
                <div className="rb-title-row">
                  <h1>{activeEntry.ticker} · {activeEntry.form} · {activeEntry.periodEnd}</h1>
                  <span className="ra-badge" data-status={gradeStatus(activeVersion.grade, activeVersion.veto.triggered)}>
                    {activeVersion.veto.triggered ? "红线触发 · FAIL" : `评级 ${activeVersion.grade}`}
                  </span>
                  {activeVersion.isBaseline && <span className="ra-badge">基线</span>}
                </div>
                <div className="rb-meta">
                  <span>版本 <code className="ra-mono">v{activeVersion.versionNumber}</code></span>
                  {activeVersion.gitCommit && <span>Commit <code className="ra-mono">{activeVersion.gitCommit}</code></span>}
                  {activeVersion.generatorModel && <span>生成模型 {activeVersion.generatorModel}</span>}
                  {activeVersion.judgeModel && <span>评委模型 {activeVersion.judgeModel}</span>}
                  <span>{activeVersion.createdAt}</span>
                </div>
              </div>

              <dl className="rb-score">
                <dt>总分</dt>
                <dd>
                  <strong>{activeVersion.totalScore}</strong><span className="rb-score-max"> / 100</span>
                  {compareVersion && (() => {
                    const d = formatDelta(activeVersion.totalScore - compareVersion.totalScore);
                    return <span className={`rb-delta ${d.cls}`}>较 v{compareVersion.versionNumber} {d.text}</span>;
                  })()}
                </dd>
              </dl>
            </header>

            <div className="rb-version-bar">
              <div className="rb-version-pills" role="group" aria-label="切换历史版本">
                {versions.map(v => (
                  <button
                    key={v.versionId}
                    type="button"
                    className="rb-version-pill"
                    aria-pressed={v.versionId === activeVersion.versionId}
                    onClick={() => setSelectedVersionId(v.versionId)}
                  >
                    <span className="ra-mono">v{v.versionNumber}</span>
                    {v.isBaseline && <span>基线</span>}
                    <span className="ra-mono">{v.totalScore}</span>
                  </button>
                ))}
              </div>
              {versions.length > 1 && (
                <label className="rb-compare-control">
                  <span>对照版本</span>
                  <select value={compareVersionId} onChange={e => setCompareVersionId(e.target.value)}>
                    <option value="auto">上一版本（自动）</option>
                    <option value="none">不对照</option>
                    {versions
                      .filter(v => v.versionId !== activeVersion.versionId)
                      .map(v => (
                        <option key={v.versionId} value={v.versionId}>
                          v{v.versionNumber}{v.isBaseline ? " (Baseline)" : ""} · {v.totalScore} 分
                        </option>
                      ))}
                  </select>
                </label>
              )}
            </div>

            <div className="rb-goal-strip">
              <div><strong>本次修改目标</strong>{activeVersion.goal}</div>
              {activeVersion.pairwiseVsPrev && (
                <span className="ra-badge" data-status={activeVersion.pairwiseVsPrev.outcome === "WIN" ? "reviewed" : activeVersion.pairwiseVsPrev.outcome === "LOSS" ? "failed" : "caution"}>
                  A/B 盲评: {activeVersion.pairwiseVsPrev.outcome}
                </span>
              )}
            </div>

            <div className="rb-veto-row">
              {(["v1", "v2", "v3"] as const).map((k, idx) => {
                const rule = rubric.vetoRules[idx];
                const check = activeVersion.veto[k];
                const pass = check ? check.pass : true;
                return (
                  <span key={k} className="ra-badge" data-status={pass ? "reviewed" : "failed"} title={check?.note || rule?.description}>
                    {rule?.id ?? k.toUpperCase()} {rule?.name ?? ""}: {pass ? "通过" : `触发${check?.note ? ` (${check.note})` : ""}`}
                  </span>
                );
              })}
            </div>

            <dl className="rb-dim-grid">
              {rubric.dimensions.map(dim => {
                const score = activeVersion.dimensions?.[dim.id]?.score ?? computeDimensionScore(dim.id, subItemMap);
                const prevScore = compareVersion
                  ? (compareVersion.dimensions?.[dim.id]?.score ?? computeDimensionScore(dim.id, compareSubItemMap))
                  : null;
                const d = formatDelta(prevScore != null ? score - prevScore : null);
                return (
                  <div key={dim.id} className="rb-dim-cell">
                    <dt className="rb-dim-label">{dim.name}</dt>
                    <dd className="rb-dim-value">
                      <span>{score}</span>
                      <small>/ {dim.max}</small>
                      {prevScore != null && <span className={`rb-delta ${d.cls}`}>{d.text}</span>}
                    </dd>
                  </div>
                );
              })}
            </dl>

            <div className="ra-tabbar rb-views">
              <div className="ra-segmented" role="group" aria-label="评测视图">
                <button type="button" aria-pressed={tab === "subitems"} onClick={() => setTab("subitems")}>评分明细</button>
                <button type="button" aria-pressed={tab === "history"} onClick={() => setTab("history")}>历史版本</button>
                <button type="button" aria-pressed={tab === "article"} onClick={() => setTab("article")}>原文对照</button>
                <button type="button" aria-pressed={tab === "feedback"} onClick={() => setTab("feedback")}>负反馈{activeVersion.negativeFeedback?.length ? ` (${activeVersion.negativeFeedback.length})` : ""}</button>
              </div>
            </div>

            {tab === "subitems" && (
              <div className="rb-table-wrap" role="region" aria-label="分项评分" tabIndex={0}>
                <table className="rb-table">
                  <thead>
                    <tr>
                      <th>编号</th>
                      <th>小项名称</th>
                      <th style={{ textAlign: "right" }}>得分</th>
                      <th style={{ textAlign: "right" }}>较对照 Δ</th>
                      <th>根因</th>
                      <th>证据与扣分说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rubric.dimensions.map(dim => (
                      <Fragment key={dim.id}>
                        <tr className="rb-dim-divider">
                          <td colSpan={6}>{dim.id} · {dim.name}（满分 {dim.max}）</td>
                        </tr>
                        {rubric.subItems.filter(s => s.dimension === dim.id).map(sub => {
                          const cur = subItemMap.get(sub.id);
                          const prev = compareSubItemMap.get(sub.id);
                          const delta = cur && prev ? cur.score - prev.score : cur?.delta ?? null;
                          const d = formatDelta(delta);
                          return (
                            <tr key={sub.id}>
                              <td className="ra-mono">{sub.id}</td>
                              <td style={{ whiteSpace: "nowrap" }}>{sub.name}</td>
                              <td className="rb-num">{cur ? `${cur.score} / ${sub.max}` : `— / ${sub.max}`}</td>
                              <td className="rb-num"><span className={`rb-delta ${d.cls}`}>{d.text}</span></td>
                              <td>{cur?.rootCause ? <span className="ra-badge" data-status="caution">{cur.rootCause}</span> : <span style={{ color: "var(--ink-muted)" }}>—</span>}</td>
                              <td className="rb-evidence">{cur?.evidence || "—"}</td>
                            </tr>
                          );
                        })}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {tab === "history" && (
              <div className="rb-table-wrap" role="region" aria-label="版本历史" tabIndex={0}>
                <table className="rb-table">
                  <thead>
                    <tr>
                      <th>版本</th>
                      <th>修改目标</th>
                      <th style={{ textAlign: "right" }}>总分</th>
                      <th style={{ textAlign: "right" }}>较上版 Δ</th>
                      <th>评级 / 红线</th>
                      <th>A/B 盲评</th>
                      <th>Commit / 时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...versions].reverse().map(v => {
                      const idx = versions.findIndex(x => x.versionId === v.versionId);
                      const prev = idx > 0 ? versions[idx - 1] : null;
                      const d = formatDelta(prev ? v.totalScore - prev.totalScore : v.deltaFromPrev ?? null);
                      return (
                        <tr
                          key={v.versionId}
                          className={`rb-clickable${v.versionId === activeVersion.versionId ? " rb-active" : ""}`}
                          onClick={() => setSelectedVersionId(v.versionId)}
                        >
                          <td><button type="button" className="rb-history-select ra-mono" aria-pressed={v.versionId === activeVersion.versionId}>v{v.versionNumber}{v.isBaseline ? "（基线）" : ""}</button></td>
                          <td>{v.goal}</td>
                          <td className="rb-num">{v.totalScore}</td>
                          <td className="rb-num"><span className={`rb-delta ${d.cls}`}>{d.text}</span></td>
                          <td>
                            <span className="ra-badge" data-status={gradeStatus(v.grade, v.veto.triggered)}>
                              {v.veto.triggered ? "红线触发" : v.grade}
                            </span>
                          </td>
                          <td>{v.pairwiseVsPrev?.outcome ?? "—"}</td>
                          <td className="rb-evidence">
                            {v.gitCommit && <code className="ra-mono" style={{ marginRight: 8 }}>{v.gitCommit}</code>}
                            {v.createdAt}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {tab === "article" && (
              <div>
                {compareVersion && (
                  <div className="rb-article-toolbar">
                    <button
                      type="button"
                      className="fm-button"
                      aria-pressed={splitArticle}
                      onClick={() => setSplitArticle(s => !s)}
                    >
                      {splitArticle ? "切回单栏阅读" : `与 v${compareVersion.versionNumber} 并排对照`}
                    </button>
                  </div>
                )}
                <div className={`rb-article-grid${splitArticle && compareVersion ? " split" : ""}`}>
                  {splitArticle && compareVersion && (
                    <div className="rb-article-pane">
                      <div className="rb-article-pane-head">
                        <span>对照版本 v{compareVersion.versionNumber}{compareVersion.isBaseline ? " (Baseline)" : ""}</span>
                        <span className="ra-mono">{compareVersion.totalScore} 分 · {compareVersion.grade}</span>
                      </div>
                      <ArticleView version={compareVersion} />
                    </div>
                  )}
                  <div className="rb-article-pane">
                    <div className="rb-article-pane-head">
                      <span>当前版本 v{activeVersion.versionNumber}{activeVersion.isBaseline ? " (Baseline)" : ""}</span>
                      <span className="ra-mono">{activeVersion.rawArticle.format} · {activeVersion.totalScore} 分 · {activeVersion.grade}</span>
                    </div>
                    <ArticleView version={activeVersion} />
                  </div>
                </div>
              </div>
            )}

            {tab === "feedback" && (
              <div className="rb-feedback-list">
                {(activeVersion.negativeFeedback ?? []).length === 0 ? (
                  <p className="rb-empty-state">该版本暂无负反馈</p>
                ) : (
                  (activeVersion.negativeFeedback ?? []).map(fb => (
                    <article key={`${fb.priority}-${fb.rootCause}`} className="rb-feedback-item">
                      <div className="rb-feedback-head">
                        <span className="ra-badge" data-status="caution">P{fb.priority} · {fb.rootCause}</span>
                        {(fb.targetSubItems ?? []).map(id => (
                          <span key={id} className="ra-badge ra-mono">{id}</span>
                        ))}
                      </div>
                      <p>{fb.suggestion}</p>
                      {(fb.targetFiles ?? []).length > 0 && (
                        <div className="rb-feedback-files">
                          {(fb.targetFiles ?? []).map(f => <code key={f}>{f}</code>)}
                        </div>
                      )}
                    </article>
                  ))
                )}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
