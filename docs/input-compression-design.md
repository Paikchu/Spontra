# 模型输入压缩方案

2026-10-19 · 状态：P0、P1 已实现，未上线；P2–P4 为方案

## 基线

数据来自分析库 `ai_usage`（每次模型调用一行）。Claude 调用从 2026-10-17 14:00 UTC 开始。按 10-19 的模型配置（分析师 Sonnet 5.5，其余工具 Haiku 5.5）重算 10-17 14:00 至 10-19 00:00 的同等工作量，约 $17.4：

| 功能 | 金额 | 主要构成 |
| --- | --- | --- |
| 分析师 analyst | $11.7 | 输出与回传的推理约 44%，第 1 轮开场约 18%，后续轮次重复读取已缓存历史约 19% |
| 网页 web | $3.5 | 搜索按次计费 $1.79，读网页 $1.29（整页进入模型输入） |
| 财报摘要 sec-analysis | $1.1 | 6 次超过 10 万 tokens 的调用占 $0.97 |
| 业务脑图 tree | $0.55 | 85–90% 已命中缓存 |
| 其余 | < $0.5 | 翻译、要点、图表、业务标签 |

两条价格事实决定了方案的重点：

- Haiku 5.5 单次提示超过 10 万 tokens 时，输入、输出单价都变为 5 倍（$0.50 / $2.50 每百万）。把单次输入压到 10 万以内，本身就能降一个价格档。
- 缓存命中按 0.1 倍计价。同一段内容在多轮或多个任务里重复发送时，放进缓存前缀比压缩它更省事。

另一条与价格无关：Haiku 处理长上下文的能力不如 Sonnet，少给无关内容同时有利于质量。

## 原则

1. 能用代码完成的事不交给模型：抓网页、转文本、去重、筛选、排序。
2. 模型读摘要和索引，需要原文时按 id 用工具取。代码对原文的校验（逐字引用、证据 id）保持不变，原文继续保存在存储里。
3. 稳定内容在前，易变内容在后，在两者之间加缓存断点。
4. 不花钱的检查放在花钱的步骤之前；相同输入只付一次钱。
5. 不改写已经发生的对话轮次。推理块只有在系统提示、工具和全部历史原样回传时才有效，`test/analyst.test.ts:66`、`test/lens.test.ts:168`、`test/business-tree.test.ts:134` 都断言请求只增不改。压缩只能在内容写入历史之前做。

## P0 止血

### P0-1 财报摘要：数据检查前移

NBIS 的财报摘要在 10-19 失败两次（09:22、10:32），错误相同：`Conflicting history units for capex`。这项检查在 `assertBriefCanProceed`（`workflow-core.ts:399`），只依赖财务历史，与模型无关。但它排在 discovery 之后（`workflow-core.ts:216-237`），所以每次失败前都已跑完 64 次 discovery 调用，约 63 万输入、14 万输出 tokens。

改法：

- 把 `context` 和 `brief` 两步移到 discovery 之前，单位冲突在调用模型前就失败。
- “无核心数据”这项检查依赖 `groundedDisclosures`，仍留在 discovery 之后。
- 核对自动重试对 `hard_failure` 的处理：确定性错误不应重复排队。
- NBIS 的 capex 单位冲突本身是数据问题，另行处理。

### P0-2 相同输入不重复付费

模型断点按 `workflowInstanceId` 存放（`operations.ts:167`），新实例无法复用旧结果。NBIS 两次运行发出的 discovery 输入逐字相同（都是 633,133 tokens）。

改法：已完成的 discovery 分块结果按 `accession + DISCOVERY_VERSION + 分块文本哈希 + 模型` 存储，跨实例复用。这与“财报数据在入库时准备好”的做法一致。

## P1 网页读取绕开模型

现状：`ClaudeWebProvider.fetchContent`（`web-search/claude.ts:101`）让模型调用 `web_fetch`，整页内容（advanced 最多 10 万 tokens）进入模型输入，模型只回复“done”。平均每页 3.3 万 tokens，最大 38 万。

调用方实际只保留很少一部分：

| 调用方 | 保留内容 |
| --- | --- |
| 分析师 | 9,000 字摘录（`analyst/web.ts:15`） |
| 业务脑图 | 6,000 字（`READ_CHARS`） |
| 公司分析 | 前 14,000 字（`business-tools.ts:114`） |
| 业务解读 | 6,000–20,000 字 |

模型读进去的内容九成以上被丢弃。

改法：

- **W1：Worker 自己抓取。** `fetch(url)`，`Accept` 依次为 `text/markdown`、`text/html`、`application/pdf`。
  - 很多站点开了 Cloudflare 的 Markdown for Agents，会直接返回 Markdown。
  - HTML 交给 Workers AI 的 `env.AI.toMarkdown()` 转换（pipeline 已绑定 `AI`；HTML、PDF 的转换不按 token 计费）。
  - PDF 沿用现有的 `unpdf`。
  - 重定向设为 `manual`，每一跳都用 `publicUrl()` 校验，避免访问内网地址。响应体上限 8 MiB，超时 20 秒。
- **W2：Claude `web_fetch` 降为兜底。** 只在 401/403/429、挑战页，或抽出的正文少于约 500 字（页面靠 JS 渲染）时使用。`max_content_tokens` 从 10 万/4 万降到 2.5 万/1 万。
- **W3：分开缓存版本。** 读网页用自己的 provider id，搜索保持 `claude-web:v1`，这样已有的搜索缓存不会失效。
- **W4：搜索共享公开范围。** 公开网页的搜索结果按 `docs/web-search.md` 允许的统一 scope 共享，分析师、脑图、业务解读之间不再各搜一遍。重复程度目前未量化，缓存表只存哈希。

预计效果：读网页的输入从每 1.5 天 420 万 tokens 降到只剩兜底部分（估计占 10–30%），同等工作量下 $1.29 降到约 $0.2。搜索按次计费（每次 $0.01）无法靠压缩降低，只能靠 W4 减少次数。

实现（W1–W3）：`web-search/page.ts` 的 `DirectPageProvider` 包住 `ClaudeWebProvider`，在 `research-search.ts` 组装。

- 每次读网页写一条日志 `web-page-read`，记录 `outcome`（direct 或 fallback）和 `reason`。兜底的 Claude 调用照常进入 `ai_usage`，记为 `web-fetch`。
- 兜底比例 = `web-fetch` 行数 ÷ `web-page-read` 条数。
- 读网页的缓存键改为 `direct-page:v1+claude-web:v1`，旧的网页缓存不再命中。新版读取不花 token，所以这不增加费用；搜索缓存不受影响。

P0 的实现：

- 数据检查前移在 `workflow-core.ts`，单位一致性检查拆成 `assertHistoryUnits`。
- discovery 复用在 `operations.ts` 的 `scanDisclosures`。只有通过校验的分块才会存储，存在 `filings/<代码>/<accession>/discovery-cache/sec-discovery.v1/<哈希>.json`，随所属财报一起被存储清理覆盖。
- 测试：`test/report-spend.test.ts`、`test/direct-page.test.ts`。

## P2 财报摘要：每次调用压到 10 万 tokens 以内

一份 AMZN 财报跑一遍是 71 次调用、222 万输入 tokens，其中 139 万来自 6 次超过 10 万的调用：

| 阶段 | 单次输入 | 主要内容 |
| --- | --- | --- |
| discovery:N | 约 9.4k | 20,000 字一块，最多 64 块；正文加除 EX-101 外的全部附件 |
| manager | 约 95k | 完整 brief，包括 22 个序列 × 13 期 × 约 16 个字段的历史，以及最多 12 万字的往期报告原文 |
| manager-review:N | 约 160k | brief、计划、全部 disclosures 和每个节点的叙述、事实、证据 |
| synthesis | 约 215k | 以上内容再发一遍，加 primaryEvidence（上限 16 万字）和 7k 字的输出结构 |
| editorial-review:N | 约 224k | 草稿、完整历史、往期报告、节点、primaryEvidence；最多 5 轮 |
| editorial-revision:N:M | 约 406k | 草稿对象把节点、计划重复 2 次，discovery 重复 3 次，阅读版重复 2 次（`operations.ts:486`） |

这些调用只缓存了系统提示（`operations.ts:731`）。整个 payload 是一条 JSON 用户消息，没有缓存断点，每一轮都全价重发。

改法：

- **S1：草稿去重（改动最小、收益最大）。** `reviseReport` 只传补丁可能修改的字段，即阅读版和摘要字段，不再展开整个 `artifact.report`。`applyEditorialPatch` 也不再把整份草稿带入下一次尝试（`editorial.ts:131`）。目标：40 万降到 10 万以内。
- **S2：discovery 只扫有用部分。** 跳过证明书、合同、子公司列表、同意函、追回政策等附件（EX-31/32/10/21/23/97），保留正文和业绩类附件（EX-99.x）。文件库已有 `role='boilerplate'` 标记，可以直接使用。目前 AMZN 有 47 块，NBIS 达到 64 块上限，块数预计减少一半以上，需要实测确认。
- **S3：稳定前缀缓存。** 每轮都相同的内容作为第一个用户内容块，加 1 小时缓存断点：brief、disclosures、节点结果、primaryEvidence、输出结构、允许的 id 列表。草稿、问题、轮次放在后面。
  - 这样 manager-review 的第 2 轮、editorial-review 的第 2–5 轮，以及每轮修订的多次尝试，都按 0.1 倍计价。
  - 字段顺序目前是易变内容在前（`operations.ts:463`、`pipeline.ts:518`），需要调换。
- **S4：用紧凑形式替换全文。**
  - `history` 改为列式，每个序列一行，期间和数值各用一个数组；也可以直接用已有的 `buildSecTrends`。
  - `reportContinuity` 只传往期报告里的判断句，不传全文。`priorJudgment` 需要逐字引用，判断句本身就是原文，代码校验不受影响。
  - `primaryEvidence` 只给当前问题涉及的 section 所引用的证据（修订阶段已有 `allowedSectionIds`）。其余证据给 420 字预览加 id，模型需要时再取。

目标：单份财报的输入从 222 万降到约 70 万，所有调用都在 10 万以内。按 Haiku 计，每份约 $1.0 降到约 $0.2。

## P3 分析师：缩小开场，跨发现共享缓存

分析师是剩余花费的主体。10-18 共 $11.5，其中：

| 部分 | 金额 |
| --- | --- |
| 后续轮次 | $8.5（输出 $4.6，读缓存 $2.1，新内容 $1.8） |
| 第 1 轮开场 | $2.05 |
| 复核 | $0.99 |

开场平均 3.3 万 tokens，几乎没有命中缓存。之后每一轮都会把开场重新读一遍：223 次后续调用 × 3.3 万 tokens，相当于 745 万 tokens 的缓存读取。

改法：

- **A1：调整开场顺序。** 公司级内容放在前面并加断点：documents、catalogue、events、background、chartGrammar、peerRefs。发现专属的 subject、lines、evidence 放在后面（目前顺序相反，`analyst/agent.ts:274-285`）。
  - 同一公司的多个发现是并行跑的（`analyst/workflow.ts:155`）。可以先跑一个发现把缓存写好再并发，或者用 `max_tokens: 0` 的请求预热。
- **A2：documents 瘦身。** 这是开场里最大的一项，约 1.5–2.2 万 tokens：3 份文件 × 最多 60 个 section × 中文要点（`agent.ts:211`）。
  - 只放与本发现各条 lines 相关的 section（按关键词或向量预选），去掉两份 10-Q 之间重复的路径。其余 section 仍可通过 `find_sections` 找到。
  - 目标：开场从 3.3 万降到约 1.5 万。
- **A3：工具输出去重。**
  - 重复 `read_section` 时只回复“已在 [id] 展示”。目前同一段原文会再发一遍。
  - `peers` 不再重复开场里已有的 peerRefs。
  - `compile` 的返回只包含错误和改动部分，不再逐条列出所有序列值。
- **A4：推理强度。** 10-19 已改为 low。输出 token 和每轮回传的推理会同时减少，效果需要观察一周账本。

预计效果：A1 加 A2 把第 1 轮从 $2.05 降到约 $0.5，后续轮次的缓存读取减少约 $0.8，同等工作量下分析师约便宜 20%。这还不算 A4 的效果。

## P4 其他阶段（金额小，主要为了质量）

- **F1：findings-write 的 ledger 改列式。** 目前最多 640 行，每行都重复 ref、标签和期间（`findings/ledger.ts:132`），约 2.8 万 tokens。改为每个 ref 一行、各期数值放进数组，估计降到约 1.2 万。
- **F2：findings-repair 只发需要的部分。** 只传被拒的发现和它们引用的行，并沿用 `FINDINGS_SYSTEM` 前缀以命中缓存。目前是整个 write 的 payload 再加上被拒内容（`findings/writer.ts:105`）。
- **T1：业务脑图。**
  - 增删改的结果只回传变化，不再附整棵树（最多 40 个节点，`business-tree/agent.ts:339`）。
  - 重复 `read` 只回传没看过的段落，并给 `read` 的观察加上限（目前没有上限，`agent.ts:328`）。
- **B1：business-evidence-review 只传被引用的观察。** 只给报告段落引用到的 observations，不再把全部 observations 和整篇报告再发一遍（`company-analysis/business-agent.ts:100`）。

## 不做或暂缓

- 裁剪或改写历史轮次：违反原则 5。
- 服务端 context editing（`clear_tool_uses`）：与推理块保留规则是否兼容未经验证。要用需先实测，确认不会让推理块失效。
- 把分析师换成 Haiku：属于质量取舍，不在本方案范围内。

## 验证

- **成本：** 每项上线前后，对比 `ai_usage` 同一阶段的平均输入、缓存和输出。payload 日志从只记总字符数（`inputCharacters`，`operations.ts:706`）扩展为按字段记录，确认每项压缩落在预期的字段上。
- **质量：** 固定样本为 ORCL、AMZN、NBIS，对比发布结果，包括发现数、被拒数、editorial-review 的问题数、脑图节点数。逐字引用和证据 id 的代码校验全部保留，压缩不放宽任何校验。
- **发布：** 按 AGENTS.md 推送 `main`，由自动构建部署，并分别核验 pipeline 的构建结果。

## 实施顺序

| 顺序 | 内容 | 改动范围 |
| --- | --- | --- |
| 1 | P0-1、P0-2 | `workflow-core.ts`、`operations.ts` |
| 2 | W1–W3 | `web-search/` |
| 3 | S1、S3 | `operations.ts`、`sec/pipeline.ts`、`sec/editorial.ts` |
| 4 | A1、A2、A3 | `analyst/agent.ts`、`analyst/workflow.ts` |
| 5 | S2、S4、F1、F2、T1、B1、W4 | 各自模块 |

每一步单独上线、单独看账本，再进行下一步。
