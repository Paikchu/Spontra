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
| `edgarListings(env)` | 发行人目录、submissions 列表及分页、Company Facts、申报索引页、Form 3/4/5 XML。只说明“有什么”，不返回申报正文 | 申报发现 Cron、SEC 财报的 `discover`、事件任务、发行人目录（`catalog/issuer-directory.ts`）、采集请求、基本面刷新 |
| `archivingReader(env, ticker)` | 唯一会下载申报正文的 reader：下载即按内容哈希归档，已归档的直接从 R2 读 | 财务采集、补历史、财务维护、报表结构判断、`archive` 任务 |
| `archivedFiling(env, ticker, accession)` | 一份申报在归档中的全部文档（正文在前，附件在后）及其原文 | SEC 财报 `prepare`、要点条目的 8-K 回退 |
| `archivedExhibits(env, ticker, accession, date)` | 业绩 8-K 的 EX-99 文本（文件库尚未拆解时） | 前瞻指引 |
| `secFilingTools(input)` | 挂到 Agent 上的 SEC 资源：列申报、找章节、读段落并登记为材料 | compose（要点、条目分析等所有写分析的 Agent） |

`gateway.ts` 不在 `index.ts` 以外导出。EDGAR 地址统一定义在 `shared/analysis-runtime/sec-sources.ts`，网关用它拼请求。`scripts/check-analysis-boundary.ts` 在构建时拒绝：`workers/analysis/src` 中 `sec-archive/` 以外的代码出现 EDGAR 清单端点字面量或引用清单地址构造函数（`secSubmissionsUrl`、`secSubmissionsPageUrl`、`secCompanyFactsUrl`、`SEC_EXCHANGE_DIRECTORY_URL`、`SEC_TICKERS_URL`）、在模块外构造 EDGAR reader，或以值导入 `gateway.ts`。`workers/analysis/scripts/` 下的本地维护脚本不在此范围内。`/Archives/edgar/data/...` 的文档 URL 是数据，各模块仍可持有和比较。

## 事件链的变化

- `filing.discovered` 不再直接触发 SEC 财报。SEC 财报改为订阅 `filing.archived`（定期报告、8-K、6-K）：`shouldAnalyze` 对归档里没有的申报返回“跳过”，等它归档后由新事件再起一次运行。
- 财务采集只读 10-Q、10-K、20-F 原件、增量窗口内的 6-K 与定期报告修正版、以及业绩 8-K 原件。除未修订的 10-Q/10-K/20-F 外，SEC 财报要读的申报（8-K、6-K、40-F 及所有修正版）以及要点条目分析要读的招股说明书补充（424B）都由新任务 `archive` 归档，判定统一在 `pipeline/filing-forms.ts`（`archivedForm`）；归档任务读 6-K 时不套用采集器的“是否报财务”判断，通告类 6-K 的附件也会存入：采集已存入的文档经 `archived` 钩子从 R2 读回、按内容哈希命中，不会再下载或重写，所以两条路径并存只多一次 D1 标记。申报发现在 D1 状态里记下这些申报（`current`），任务按新到旧每轮存 2 份，发出同样的 `filing.archived`；存不进去的申报（文档超过大小上限，或 SEC 连续 5 次未能提供）记为 unsupported 后跳过，不挡住其后的申报；建立基线时（含首次引导）发 `archive.requested`，覆盖此前已有的申报。一份申报的全部文档都存好后才写完成标记（`sec-archive:complete:v1:{ticker}:{accession}`）；存到一半中断的，下一轮从归档读回已存的部分，补齐其余文档。读取侧同样只认完整的申报：`archiveHolds` / `archivedExhibits` 以正文所链接的 EX-99 是否都已存入判断，正文先到、附件未到时财报分析与指引都继续等待。
- 前瞻指引的材料顺序：文件库已拆解的 EX-99 → 归档原文；不再读 EDGAR。业绩发布两者都还没有（申报列表先于采集被索引）时，指引任务不启动 Workflow，事件保持 `queued`；该 8-K 的 `filing.archived` 让任务重跑，此外每 6 小时检查一次。已经启动的 Workflow 读不到时，也把事件放回队列。发布日起 2 天仍未归档的，按现有材料运行。
- 业务脑图、业务解读、stage 的 `read_web`：对 sec.gov 的网页抓取由 `WebSearchService.fetchContent` 统一拒绝（`archive_only`）。SEC 原文只经文件库读取。

## 已知取舍

- 归档的附件范围沿用采集器：正文加最多两个 EX-99。SEC 财报以前通过 submission 流读到的其他文本附件（EX-10 等）现在不在材料内；需要时扩大采集器的归档范围，而不是另开下载路径。
- 事件任务读取的 Form 4 XML 与申报索引页属于清单层，不归档。
- 测试用的 `SecReader` 假对象需要实现 `submissions` 与 `issuerDirectory`。
