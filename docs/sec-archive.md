# SEC 归档：唯一的 EDGAR 入口

日期：2026-10-24。状态：已实现。

## 一句话

Spontra Analysis 只在一个模块里访问 EDGAR：`workers/analysis/src/sec-archive/`。它分两面——**清单**（哪些申报存在）和**下载并归档**（把申报原文存进 R2、指针写进 D1）。其余所有功能、Workflow 和 Agent 需要 SEC 原文时，只能读已归档的文件：原始 HTML（`archivedFiling`）或文件库拆好的段落（`find_sections` / `read_section` 工具）。不再有第二条下载路径，也不经网页搜索抓取 sec.gov 页面。

## 为什么

重构前 EDGAR 被五处各自读取：财务采集（唯一会归档的一处）、SEC 财报的 `prepareSecFiling`（每次重新流式下载整个 submission）、指引的 EX-99 兜底、事件的 Form 4 与索引页、以及业务脑图/业务解读经 Tavily 抓取 sec.gov 页面。同一份文件被下载多次，而且只有第一处的副本会留下来；后续任务读到的文本可能与归档的不一致，也无法离线重算。

## 模块边界

```
sec-archive/
  gateway.ts   EDGAR 网络层（模块私有）：节流、contact user-agent、主机白名单、大小上限
  archive.ts   归档读写：archivedFiling / archivedExhibits / readArchivedDocument / archivingReader
  task.ts      `archive` 任务：把财务采集不读的 8-K（无 Item 2.02）归档
  tool.ts      Agent 工具集：list_filings / find_sections / read_section（只查 D1）
  index.ts     对外唯一出口：edgarListings、archivingReader、archivedFiling…
```

| 对外接口 | 做什么 | 谁用 |
|---|---|---|
| `edgarListings(env)` | 发行人目录、submissions 列表及分页、Company Facts、申报索引页、Form 3/4/5 XML。只说明“有什么”，不返回申报正文 | 申报发现 Cron、SEC 财报的 `discover`、事件任务、后台发行人搜索、采集请求 |
| `archivingReader(env, ticker)` | 唯一会下载申报正文的 reader：下载即按内容哈希归档，已归档的直接从 R2 读 | 财务采集、补历史、财务维护、报表结构判断、`archive` 任务 |
| `archivedFiling(env, ticker, accession)` | 一份申报在归档中的全部文档（正文在前，附件在后）及其原文 | SEC 财报 `prepare`、要点条目的 8-K 回退 |
| `archivedExhibits(env, ticker, accession, date)` | 业绩 8-K 的 EX-99 文本（文件库尚未拆解时） | 前瞻指引 |
| `secFilingTools(input)` | 挂到 Agent 上的 SEC 资源：列申报、找章节、读段落并登记为材料 | compose（要点、条目分析等所有写分析的 Agent） |

`gateway.ts` 不在 `index.ts` 以外导出；`scripts/check-analysis-boundary.ts` 在构建时拒绝：模块外出现 EDGAR 清单端点字面量（`data.sec.gov`、`www.sec.gov/files`）、模块外构造 EDGAR reader、模块外以值导入 `gateway.ts`。`/Archives/edgar/data/...` 的文档 URL 是数据，各模块仍可持有和比较。

## 事件链的变化

- `filing.discovered` 不再直接触发 SEC 财报。SEC 财报改为订阅 `filing.archived`（定期报告、8-K、6-K）：`shouldAnalyze` 对归档里没有的申报返回“跳过”，等它归档后由新事件再起一次运行。
- 财务采集只读定期报告、6-K 和业绩 8-K。其他 8-K 由新任务 `archive` 归档：申报发现在 D1 状态里记下这些 8-K（`current`），任务按新到旧每轮存 2 份，发出同样的 `filing.archived`。
- 前瞻指引的材料顺序：文件库已拆解的 EX-99 → 归档原文 → 没有就为空；不再读 EDGAR。
- 业务脑图、业务解读、stage 的 `read_web`：对 sec.gov 的网页抓取由 `WebSearchService.fetchContent` 统一拒绝（`archive_only`）。SEC 原文只经文件库读取。

## 已知取舍

- 归档的附件范围沿用采集器：正文加最多两个 EX-99。SEC 财报以前通过 submission 流读到的其他文本附件（EX-10 等）现在不在材料内；需要时扩大采集器的归档范围，而不是另开下载路径。
- 事件任务读取的 Form 4 XML 与申报索引页属于清单层，不归档。
- 测试用的 `SecReader` 假对象需要实现 `submissions` 与 `issuerDirectory`。
