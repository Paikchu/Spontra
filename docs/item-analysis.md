# 文件与事件走要点的分析路径

**状态：** 已实现，未上线 · **日期：** 2026-10-21 · **前置：** [finding-lens-agent](finding-lens-agent.md)（P3）、[stage-agent-design](stage-agent-design.md)（§2 共享循环、§6 报告）

## 决策

侧边栏的每一行（要点、财报、8-K/6-K、被规则标记的 Form 4）用同一套 Agent 架构产出同一种文档，前端用同一条路径整页渲染在舞台上。不同的只有提示词和起始材料。

| 层 | 共用 | 按行类型不同 |
|---|---|---|
| 循环 | `agent-loop.ts` 的 `runAgentLoop` + `Recipe`：要点 lens、读者报告、文件分析都跑在它上面 | `Recipe` 的 `system`、预算 |
| 工具 | `tools/registry.ts` 的定义；`compose/tools.ts`：读数（company_overview / findings / read_series）、文件库（find_sections / read_section）、网页（报告才开）、`compose`、`finish` | 允许的工具（`ITEM_POLICY` 不含网页） |
| 校验 | `compose` 用要点页自己的校验器：判断里的数字由 evidence 产出、引文在所给段落里、必须引用文件、有更早文件时也引用 | `check` 钩子（Form 4 须引本文件和该人更早的文件） |
| 产物 | `ComposedAnalysis`（`shared/analysis-contract/findings.ts`）：finding 形状 + lens 文档 + 引用段落 | `UserReport` / `ItemAnalysis` 的外层字段 |
| 渲染 | `LensBlocks`；舞台 `data-focus="lens"` 整页让位 | 头部的类型标记与导航 |

要点的 lens agent 迁到了共享循环（`lensRecipe`），工具、提示词、步骤名（`<finding>-t<n>-act`）和轨迹不变，`LENS_VERSION` 不升，已发布的要点不重写。

## 哪些行写分析

`itemSubjects`（`workers/analysis/src/items/recipe.ts`），列表来自与页面同一个 `railEntries`（`shared/analysis-runtime/rail.ts`），近 12 个月内：

- 财报（10-Q/10-K/20-F 或业绩发布组）：等文件库切好它的正文（`library.prepared`）才写，开场列出该文件的库内文档，要求引用本期和上一期同一节。
- 8-K/6-K：库里有就读库；没有就用 SEC 报告步骤存在 R2 的正文块（`filings/<ticker>/<accession>/text.json`），再没有就从 EDGAR 读一次，按 `selectEventBlocks` 选 10 块作为 m1…；只陈述事实的文件可以没有 evidence，此时标题和判断不得含数字。
- Form 4：只有 `insiderTone` 为 attention 的（与页面同一规则，已移到 `shared/analysis-runtime/events.ts`）；evidence 用 `{ event: { id, field } }`，脚注作为可引用材料。常规、计划内、授予与行权不调用模型，页面显示其数字与持股阶梯。

## 触发与存储

- 任务 `items`（scope `findings`，即 AI 分析开关；另受 `FINDINGS_ENABLED`）。订阅 `events.published`、定期报告的 `report.published`、`library.prepared`、AI 开关的 `feature.settings`；新版本经 `task.version_changed` 为开关打开的公司各跑一次，不需要手工回填。
- `ItemsWorkflow`（`spontra-items`，并发 1）：每行一个循环，每次模型调用和外部读取都是 durable step，每行写完立即存 `item-analysis:v1:<ticker>:<id>`（含轨迹 `trace`，读路由剥离），最后写索引 `items:v1:<ticker>`（fingerprint = 版本 + 到期行 id）并发 `items.published`（修订 events、filings；翻译订阅它）。
- 读：`GET /api/v1/companies/:ticker/items/:accession`（分析 Worker）→ 地图 `/api/business/v1/companies/:ticker/items/:accession`；AI 开关对读者关闭时返回 unavailable。中文由翻译任务按资源 `item`（scope = accession）写表，读时套用。
- 模型：`AI_TOOLS.items`（reasoning 档、high），后台可改。

## 前端

`BusinessMap` 的舞台：要点、指标、财报、事件聚焦时都进入 `data-focus="lens"`，亮点、图表、时间轴、图例全部让位，只渲染 lens。`ReportLens` / `EventLens` 读该行分析（`useItemAnalysis`），按要点的方式再校验一次（`useVerifiedAnalysis`），用 `LensBlocks` 画；没有分析的行用同样的两栏 `lens-doc` 网格显示文件摘要（财报数据、事件摘要、内幕交易阶梯）。时间轴不再有"聚焦的事件"状态。

## 未做

- 后台「AI 运行」页没有 items 这一类（`AI_RUN_KINDS` 未加），运行轨迹只在存储记录里；失败经 `TASK_FEATURE` 进后台消息。
- 分析师（analyst）和三表检查笔记（checkup）仍是各自的循环，按 stage-agent-design §2.3 后续迁移。
