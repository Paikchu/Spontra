# Pipeline 事件化：只为 SEC 保留定时任务

日期：2026-10-12（同日经架构审查修订）。状态：P1–P4 已全部上线并核验，实施细节与差异见文末“实施记录”。

## 一句话

Cron 只用来访问 SEC（发现新申报），其余任务都由事件驱动：上游任务提交数据时在同一个 D1 事务里写下事件，事件经路由拆成每个订阅者一条任务消息，任务完成后再发出自己的事件。没有任何定时任务去逐家公司比对数据是否变了；D1 是唯一事实来源，事件只表示“该重新检查了”。

## 为什么改

现在两条 Cron 共 14 个任务，除了真正需要访问外部来源的，其余都在“轮询比对”：每轮读出全部输入、算指纹、和上次比较，绝大多数时候什么也不做。

- `*/2` 的地图推导：每轮读 10 家公司的披露记录、已解析季度、快照和发布数据（约 5.8 MB JSON），实际每家每天只重建约 1 次。`cache_key LIKE ?` 用不上主键索引，每次扫全表 `sec_cache`（实测 1,467 行），一天约 2,100 万行读取。
- `*/10` 的要点、业务脑图、业务解读：每 10 分钟逐家读输入、比较指纹。
- 同一个 EDGAR 接口 `data.sec.gov/submissions` 被 4 处各自读取：财务采集（`financial-data/provider.ts`）、补历史季度（`financial-data/history.ts`）、SEC 财报的发现步（`sec/pipeline.ts`，12 小时一次）、事件（`events/workflow.ts`，6 小时一次）。
- 新财报进地图最长要等 24 小时（财务采集每家每天一次）。
- 要点生成时只看到最新两个季度：`findings/workflow.ts` 读 `publication.reports`，但 `readCompletePublicationForTicker` 从不填这个字段；而地图核验要点时用的是快照里最多 8 个季度和快照的资本结构。生成与核验看到的数据不一致。

CPU 成本不大（估算每月约 100 万 CPU 毫秒，付费计划含 3,000 万），问题是浪费的 D1 读取、和财务采集共用同一次调用的 CPU/内存，以及每加一个下游任务就要再加一套轮询。

## 原则

1. **Cron 只做 SEC 发现。** SEC 不推送，只能轮询。其余任何“定期看看有没有事”的逻辑都不保留，包括对账、清理、死信处理。
2. **读取路径不写数据。** `MapReads` 和后台读取接口不挂任何钩子，不补发事件、不检测版本、不触发任务。
3. **事件和数据同一事务提交。** 写业务数据的同一个 `db.batch` 里写发件箱，没有例外。
4. **事件只带身份和类型，任务读 D1 最新状态。** 重复、乱序都无害；任务用指纹、版本号、Workflow 实例 ID 去重。
5. **按职责分队列，不按任务分。** 新增下游任务只在订阅表加一行，不新建队列、标记或定时任务。
6. **短反应用队列，长流程用 Workflow。** 需要多步、等待数小时到数天的流程交给 Workflow 的持久化步骤和 `step.sleep`，不用一串延迟消息拼出来。

## 架构

```
SEC 申报发现 Cron（*/10，写心跳）
      │
      ▼
D1：业务数据 + pipeline_outbox（同一 batch）
      │ 提交后立即发送；Cron 与队列消费者入口补发积压
      ▼
spontra-pipeline-events（批量 100，等 30 秒）
      │ 路由：按 CIK 合并 → 查订阅表 → 写 pipeline_due（防抖）→ 发延迟任务消息
      ▼
spontra-pipeline-tasks（每批 1 条，并发 1）
      │ 到期检查 → 就绪检查 → 执行：短任务直接做；长流程启动 Workflow
      │ 完成：业务数据 + 新事件写入发件箱（同一 batch）
      │ 失败：退避重试，超过次数 ▼
spontra-pipeline-dlq ──▶ D1 pipeline_dead ──▶ 后台展示、报警、重放

MapReads / 后台读取：只读 D1，不挂钩子
```

### 为什么是两条队列

一次消费调用里的所有消息共享 5 分钟 CPU 和 128 MB 内存。事件需要大批量才能合并同一家公司的重复事件；任务需要独占调用，否则一次财务采集（SEC 节流加 HTML 解析）和一次地图推导（最多解析 32 MB）进同一批就可能超内存，慢任务也会挡住后面的 AI 任务启动。两条队列按“路由”和“执行”分工，与任务数量无关。

### 为什么路由拆消息，不做进程内广播

Cloudflare Queues 没有主题和广播，一个队列只有一个消费者，每条消息至少投递一次。如果一条事件进来、消费者依次调用所有订阅者，消息只能整体确认或整体重试：A 成功、B 失败时，要么 A 重跑，要么 B 丢失。路由把事件拆成每个订阅者一条任务消息，每个下游的完成状态由队列独立跟踪。

## 改造后保留的 Cron

| Cron | 做什么 | 为什么必须保留 |
|---|---|---|
| `*/10 * * * *` SEC 申报发现 | 对每家数据公司读一次 `data.sec.gov/submissions`，与 D1 中的申报列表（`sec:filings:<ticker>`）比较；新申报写入列表，并在同一 batch 里为每份新申报写一条 `filing.discovered`（带 CIK、表单类型、8-K Item）；成功后写心跳 | SEC 不推送新申报；10 家公司每轮 10 次请求，按 1 次/秒节流约 10 秒 |

`*/2` 整条删除；`*/10` 里的其他 9 个任务全部移出。

Cron 和两个队列消费者的入口各做两次主键查询：补发发件箱积压、比较任务版本哈希（见“保证链”）。这是事件库的一部分，不是独立的定时任务；HTTP 入口不做。

## 任务表

“执行方式”中，**队列任务**指在任务消息里直接完成；**Workflow** 指任务消息只负责启动（实例 ID 去重），长流程在 Workflow 内运行，完成时由 Workflow 写事件。

| 任务 | 现在 | 改造后由什么触发 | 执行方式 | 完成后发出 |
|---|---|---|---|---|
| 财务采集 `runDataOnlySweep` | `*/2`，每家每天重采一次 | `filing.discovered`（10-Q、10-K 及修订、8-K Item 2.02） | Workflow，每步调用现有的采集步骤函数，D1 游标保留 | `financials.published`、`filing.archived` |
| 补历史季度 `runHistoryTick` | `*/2` 空闲时推进一步 | `company.added`；历史不完整时的 `financials.published` | Workflow，逐步推进直到游标完成 | `filing.archived` |
| 刷新过期投影 `refreshStaleProjections` | `*/2` 空闲时每次 3 份 | `task.version_changed`（资本结构口径） | Workflow，分批处理 | `filing.archived` |
| 财务维护 `runFinancialMaintenanceTick` | `*/2`，每轮推进一步 | `maintenance.requested`（后台发起） | Workflow；取消在每步开头检查 | `financials.published`、`filing.archived` |
| 地图推导 `runMapDerivationTick` | `*/2`，逐家全量比对 | `financials.published`、`filing.archived`、`task.version_changed` | 队列任务；解析预算用完时重新登记一次到期 | `map.derived`（仅在快照确实重建时） |
| 存档清理 `pruneSupersededArchives` | `*/2`，扫完后隔天再扫 R2 | `archive.superseded`（带旧对象 key） | 队列任务，到期时间设为 24 小时后；仍无引用就删除，不再扫描 R2 | — |
| Transcript `syncTranscript` | `*/2`，每轮 1 份 | `filing.archived`（10-Q、10-K） | Workflow：文字稿未出时 `step.sleep` 一天再试，3 次后标记不可用；当日额度用完睡到下一个 UTC 日 | `transcript.stored` |
| SEC 财报 `runSecRefresh` 🤖 | `*/10`，工作流内 12 小时发现一次 | `filing.discovered`（只处理 AI 公司） | Workflow；不再自己发现，读统一写入的申报列表；实例 ID 含 accession | `report.published` |
| 财报记忆 `runSecMemorySweep` 🤖 | `*/10` 认领任务 | 财报 Workflow 发布后直接排队（保留） | Workflow；卡住的租约由 Workflow 自身重试处理 | 直接启动公司分析（保留） |
| 公司分析 `runCompanyAnalysisSweep` 🤖 | `*/10`，并清理卡住的执行 | 记忆 Workflow 直接启动（保留） | Workflow；失败由 Workflow 重试，最终失败进 `pipeline_dead` | `analysis.published` |
| 基本面 `runFundamentalsStalenessSweep` | `*/10`，过期就刷新 | `filing.discovered`（10-Q、10-K） | 队列任务；companyfacts 尚未包含新申报时重新登记 6 小时后到期，最多 4 次 | `fundamentals.updated` |
| 业务解读 `runBusinessExplainerSweep` 🤖 | `*/10`，指纹比对，失败每周重试 | `financials.published`、`task.version_changed` | Workflow；指纹没变不启动；失败 `step.sleep` 后重试 | `explainer.published` |
| 业务脑图 `runBusinessTreeSweep` 🤖 | `*/10`，指纹比对，失败每周重试 | 同上 | 同上 | `tree.published` |
| 指引 `runGuidanceSweep` 🤖 | `*/10`，读缓存的申报列表 | `filing.discovered`（8-K Item 2.02） | Workflow；当日模型额度用完睡到下一个 UTC 日 | `guidance.published` |
| 要点 `runFindingsSweep` 🤖 | `*/10`，指纹比对 | `map.derived`、`guidance.published`、`fundamentals.updated`、`analysis.published`、`task.version_changed` | Workflow；先过防抖和就绪检查（见下） | `findings.published` |
| 事件 `runEventsSweep` | `*/10`，每家 6 小时自己读 EDGAR | `filing.discovered`（8-K、Form 4）、`report.published`（8-K 简析就绪） | 队列任务；不再自己读 submissions | `events.published` |

🤖 表示会调用模型。

### 要点改读地图快照

要点不再自己从披露记录组装资本结构，也不再读永远为空的 `publication.reports`，改为读地图快照（`readMapDerived`）里的历史季度和资本结构，与地图核验要点时用的数据完全一致。快照不存在或与当前发布版本不匹配时，要点视为“未就绪”，等待 `map.derived`。指纹改为包含快照的 `inputs`，替换现在的 `rpo` 字段。

这样“要点订阅地图推导”是真实依赖：地图推导先把数据准备好，要点在同一份数据上生成。

## 事件表

所有事件带 `cik` 和 `ticker`；路由和防抖按 CIK 合并，避免同一发行人的不同股票类别（如 BRK.B）重复处理。

| 事件 | 谁发出 | 谁订阅 |
|---|---|---|
| `filing.discovered` | SEC 申报发现（Cron） | 财务采集、SEC 财报、基本面、指引、事件 |
| `company.added` | 后台增加数据公司 | 财务采集、补历史季度 |
| `maintenance.requested` | 后台财务维护 | 财务维护 |
| `financials.published` | `D1CompleteStore.publish`（财务采集、财务维护都经过它） | 地图推导、业务解读、业务脑图、补历史季度 |
| `filing.archived` | `archiveFilingDisclosures`（新增，或内容、口径变化时） | 地图推导、Transcript |
| `archive.superseded` | `archiveFilingDisclosures`（替换了旧副本时） | 存档清理 |
| `map.derived` | 地图推导（快照确实重建时） | 要点 |
| `report.published` | SEC 财报 Workflow | 事件 |
| `analysis.published` | 公司分析 Workflow | 要点 |
| `fundamentals.updated` | 基本面 | 要点 |
| `guidance.published` | 指引 Workflow | 要点 |
| `task.version_changed` | Cron 或队列消费者入口检测到某个任务的版本变了 | 只路由给版本变化的那个任务，对所有公司各登记一次 |
| `transcript.stored`、`explainer.published`、`tree.published`、`findings.published`、`events.published` | 各自任务 | 暂无订阅者，先发出，供以后的任务订阅 |

## 防抖与就绪

### 防抖：`pipeline_due`

批量窗口只能合并 30 秒内的事件。要点有 4 个上游，它们在几分钟到几小时内陆续完成；每来一个就生成一次，会浪费模型调用，还会先发布一版不完整的结果。

D1 表 `pipeline_due(cik, task, due_at, first_requested_at, cause_id)`，主键 `(cik, task)`：

1. 路由收到事件，对每个订阅任务写入一行：`due_at = min(now + 防抖时长, first_requested_at + 最长等待)`。已有行就把 `due_at` 往后推，但不超过最长等待。
2. 同时发一条延迟到 `due_at` 的任务消息。
3. 任务消息到达时读这一行：行不存在，说明已经处理过，直接结束；`due_at` 还没到，说明后面有更新的消息，直接结束；否则按读到的 `due_at` 条件删除这一行，再执行任务。
4. 执行期间如果又来了新事件，会写出新行和新消息，任务结束后会再跑一次。

| 任务类型 | 防抖时长 | 最长等待 |
|---|---|---|
| 确定性任务（地图推导、事件、基本面） | 30 秒 | 5 分钟 |
| 会调用模型的任务（要点、业务解读、业务脑图） | 10 分钟 | 2 小时 |

`pipeline_due` 同时承担跨批次去重，也是“稍后再试”的统一手段：解析预算用完、companyfacts 未更新、要点未就绪，都重新写一行到期时间，不用各自发特殊消息。

### 就绪：要点等指引

防抖解决“短时间内多次触发”，不解决“上游还在跑”。新财报发布后 `map.derived` 很快到，指引还要等模型。要点的就绪规则写在任务代码里：

- 地图快照必须存在并匹配当前发布版本。
- 本期如果有业绩 8-K（`earnings_events`），对应指引必须已发布或已失败；业绩 8-K 提交超过 24 小时后不再等待。

不就绪时重新登记 30 分钟后到期。指引完成会发 `guidance.published`，通常比这个时限更早触发。

## 保证链：确保下游一定消费到

1. **生产端不丢。** 事件写进 `pipeline_outbox`，与业务数据同一个 `db.batch` 提交，没有“紧跟其后写入”的例外：R2 对象先写，D1 记录和事件一起提交。提交后立即发到 events 队列，成功后删除该行。进程在两步之间中断时，行留在发件箱里，由下一次 Cron 或队列消费者入口补发；SEC 发现每 10 分钟运行一次，积压最多停留约 10 分钟。
2. **路由不丢。** 路由写完 `pipeline_due` 并发出全部任务消息后才确认事件；任何一步失败，事件重新投递。重复投递只会把 `due_at` 再写一次。
3. **每个任务独立确认。** 失败时退避重试，超过次数进入死信队列。
4. **死信有人接。** 死信队列的消费者把消息写入 `pipeline_dead`，并以错误级别记录日志，触发 Cloudflare 的 Worker 错误通知。后台显示死信列表，支持单条或按公司重放。死信不会因为 14 天保留期到期而静默消失。
5. **重复和乱序无害。** 任务每次读 D1 最新状态，用指纹、版本号、Workflow 实例 ID 判断要不要做。
6. **代码版本变化。** 每个任务在订阅表里登记自己的版本号（如 `REPORT_QUARTERS_VERSION`、`FINDINGS_VERSION`、`BUSINESS_TREE_VERSION`）。入口比较这组版本号的哈希与 D1 中的记录（一次主键查询），不同时只为版本变化的任务发 `task.version_changed`，然后更新记录。与部署版本 ID 无关：只改了其他代码的发布，或者以后用灰度发布，都不会触发全量重跑。

没有“每日全量对账”：它是不访问 SEC 的定时任务，与原则冲突。上面 6 条覆盖了它原本要兜的情况。剩下的是代码 bug 导致任务“成功但没写对”，靠死信、日志报警和因果链排查，修复后在后台按公司重放事件。

## D1 新表

| 表 | 用途 | 清理方式（不用 Cron） |
|---|---|---|
| `pipeline_outbox` | 待发事件 | 发送成功即删除 |
| `pipeline_due` | 防抖、去重、稍后再试 | 任务执行前删除 |
| `pipeline_dead` | 死信，供后台查看和重放 | 重放成功或手动关闭时删除 |
| `pipeline_log` | 因果链：消息 ID、`cause_id`、类型、CIK、结果 | 每次写入时顺带删除同一 CIK 30 天前的记录 |
| `pipeline_versions` | 各任务版本号的哈希 | 单行，覆盖写 |

所有消息带 `id` 和 `cause_id`，链路可追溯到最初的 `filing.discovered`：`filing.discovered → financials.published → map.derived → findings`。后台 AI 任务页可以直接显示“由哪份申报触发”。

## 队列配置

| 项 | events | tasks | dlq |
|---|---|---|---|
| 名称 | `spontra-pipeline-events` | `spontra-pipeline-tasks` | `spontra-pipeline-dlq` |
| 创建 | 上线前手动 `wrangler queues create`（Wrangler 不自动创建队列） | 同左 | 配置为死信队列后自动创建 |
| `max_batch_size` | 100 | 1 | 10 |
| `max_batch_timeout` | 30 秒 | — | 30 秒 |
| `max_concurrency` | 1 | 1 | 1 |
| `max_retries` | 10 | 5 | 3 |
| `retry_delay` | 10 秒 | 60 秒（任务可覆盖） | 60 秒 |
| 死信队列 | `spontra-pipeline-dlq` | `spontra-pipeline-dlq` | — |
| 消息保留 | 14 天 | 14 天 | 14 天 |

生产者与三个消费者都是 `spontra-analysis`，`queue()` 按 `batch.queue` 分派。消息格式 `{ v: 1, id, causeId, kind, type, cik, ticker, task? }`，远小于 128 KB 上限。

tasks 并发 1 在 10 家公司时足够，同时让 SEC 访问天然不超频、D1 写入不并发。

平台限制（Cloudflare 文档）：单次消费最长 15 分钟墙钟时间；CPU 本 Worker 已配置 `limits.cpu_ms = 300000`（5 分钟）；单条延迟最长 24 小时；`sendBatch` 每次最多 100 条、256 KB。

## 运维

- **心跳。** 全系统只剩申报发现一个 Cron，它停了整条链路就静止，且不会报错。每次成功后写 `pipeline:discovery-heartbeat`；失败时抛错，让调用记录失败、触发 Worker 错误通知。后台显示上次发现时间、发件箱积压、死信数量。
- **发布时的模型成本。** `task.version_changed` 会让一个 AI 任务对所有公司重新生成。这些任务受现有每日模型额度约束，超出额度的登记到下一个 UTC 日。
- **订阅表检查。** 在 Pipeline 构建命令已有的检查步骤里加一项：订阅表必须是无环图，每个被订阅的事件都有发出方，每个任务都登记了版本号。

## 分期

| 期 | 内容 | 完成后的 Cron |
|---|---|---|
| P1 | 建三条队列、路由、订阅表与构建检查、发件箱、`pipeline_due`、`pipeline_dead`、`pipeline_log`、版本检测；迁移地图推导和存档清理；要点改读地图快照（仍由原轮询触发） | `*/2` 去掉地图推导和存档清理 |
| P2 | 财务采集、补历史、刷新投影、财务维护、Transcript 改为由事件启动的 Workflow | 删除 `*/2` |
| P3 | 新增统一的 SEC 申报发现和心跳；SEC 财报、事件、基本面、指引改为订阅 `filing.discovered`；4 处 `submissions` 读取合并为 1 处 | `*/10` 只剩申报发现 |
| P4 | 要点（防抖与就绪）、业务解读、业务脑图、财报记忆、公司分析改为订阅 | 同上，最终只剩一条 Cron |

每期独立上线、独立核验。任务本身幂等，迁移期间旧轮询与新事件并存不会出错，所以每期先接入事件、确认路径正常后再删掉对应的轮询。

## 核验

- 每期上线后：后台发件箱积压为 0、死信为 0；日志里空闲时段没有地图推导、要点等任务运行；`MapReads` 的请求不产生任何写入。
- P1：触发一次 ORCL 财务重采，`financials.published` → 地图推导 → `map.derived` 在一分钟内完成，因果链完整；地图上历史季度和资本结构正常；要点的生成输入包含快照里的历史季度。
- P3：EDGAR 出现新申报后 10 分钟内出现 `filing.discovered`；SEC 请求从 4 处轮询降为每 10 分钟 10 次。
- P4：一次新财报只产生一次要点生成，且生成时指引已就绪。
- D1 读取：地图推导相关读取从每天约 2,100 万行降到只在有事件时发生。

## 取舍记录

| 被否决的做法 | 原因 |
|---|---|
| 每个任务一个“待重建”标记 | 任务越多标记越多，仍需轮询读取标记 |
| 单队列、并发 1、批量 10 | 同批消息共享 CPU 与内存，重任务互相挤占；慢任务挡住 AI 任务启动 |
| 进程内广播 | 无法按订阅者独立确认与重试 |
| 每日全量对账 Cron | 违反“Cron 只做 SEC 发现”；由发件箱、死信、版本检测分别覆盖 |
| 用延迟消息拼长流程 | 单条延迟最长 24 小时，每周重试、隔天重试要层层续发；改用 Workflow 的 `step.sleep` |
| 用部署版本 ID 判断代码变化 | 任何发布都会全量重跑，灰度发布时来回触发 |
| 要点自己组装资本结构 | 与地图快照重复计算，且生成与核验看到的数据不一致 |

## 规模增长后要回看

- **公司上百家：** 申报发现改读 EDGAR 的汇总源；tasks 从并发 1 改为按 CIK 串行、不同公司并行（每家公司一个 Durable Object 做锁）。
- **消息量增长：** `pipeline_log` 改为按时间分区或缩短保留期。
- **出现跨公司任务（如行业对比）：** 订阅表要支持不按公司划分的事件，防抖键需要扩展。
- **历史遗留的 R2 副本：** 改造后清理只处理新产生的替换，现存的通过后台手动发一次全量清理事件处理，不建 Cron。

## 实施记录

| 期 | 状态 | 与设计的差异 |
|---|---|---|
| P1 | 已上线（bed81b2），已核验 | 见下 |
| P2、P3 | 已上线（a51f2cd），已核验 | 删除 `*/2` 前必须先有申报发现，否则新财报无人采集，所以两期一起上线；差异见下 |
| P4 | 已上线（41b647d），已核验 | 见下 |

P1 的实现要点：

- 代码在 `workers/pipeline/src/pipeline/`：`registry.ts`（事件、任务、订阅表，构建时由 `scripts/check-pipeline-boundary.ts` 校验）、`outbox.ts`、`router.ts`、`tasks.ts`（任务实现与到期检查）、`versions.ts`、`consumer.ts`（三个队列的消费入口）。后台页面“事件流水线”（`/admin/pipeline`）曾显示待发事件、待执行任务、死信、记录与触发链，可手动发事件、重放或关闭死信；2026-10-12 后台改为只服务 BusinessView 时移除，运行状况改在 Cloudflare 控制台查看，Pipeline 的 `/admin/pipeline` 接口保留。
- **防抖键用股票代码，不用 CIK。** 数据白名单每个发行人只采集一个代码（`enqueueIssuer` 取第一个允许的代码），采集、归档、发布产生的事件天然带同一个代码；事件仍带 `cik` 供排查。
- **被替换的存档副本记在 `pipeline_superseded` 表里。** 事件只带公司和类型，被替换对象的 key 是数据，与新的披露记录在同一个 batch 里写入；`archive-prune` 任务删除超过 24 小时且无引用的副本。
- **历史遗留副本的全量清理**是 `archive-prune-scan` 任务，由后台手动发送“全量清理存档副本”触发，每次推进 4 页，未完成就立即续作。
- 财务采集、补历史、刷新投影在 P1 仍由 `*/2` 运行，但它们写入的 `financials.published`、`filing.archived`、`archive.superseded` 已经进入事件链；`*/2` 结束时立即补发发件箱。

P2、P3 的实现要点与差异：

- **两期合并上线。** `*/2` 原本承担“每天重采一次”的作用，相当于财报发现；删除它之前必须先有 `filing.discovered`。
- **长流程没有改成 Workflow。** 财务采集、补历史、刷新投影、财务维护、Transcript 都是队列任务：每次运行推进一步，没做完返回“稍后继续”，由 `pipeline_due` 记下下次时间；超过 24 小时的等待由任务消息到期后再续发剩余时间。每一步都短且幂等，Workflow 的持久化步骤在这里没有额外收益，反而要为每个流程新增一个 Workflow 类。
- **`company.added` 改为 `collection.requested`。** 后台新增公司本来就会创建一个“提取”维护任务，所以发的是 `maintenance.requested`；`collection.requested` 用于后台手动“重新采集财报”和 `/sec-financials/refresh/` 接口。
- **新增 `filings.indexed`。** 指引工作流要求业绩 8-K 已在缓存的申报列表里，这个列表由 SEC 财报工作流写入；指引因此订阅列表写入事件，而不是直接订阅 `filing.discovered`。
- **Yahoo 基本面不再定时同步。** 它只被公司分析读取，改为公司分析工作流开始时检查，超过 24 小时才同步；失败沿用上次的快照。要点读的是 SEC 基本面（`sec:fundamentals:*`），由 SEC 财报工作流写入并发 `fundamentals.updated`。
- **SEC 财报工作流仍在运行时读取 EDGAR。** 轮询取消了，它只在有新申报时启动；启动后照旧自己读一次申报列表并写入缓存。任务每 5 分钟检查一次实例状态，失败的实例让任务失败、由队列重试，最后进入死信。
- **事件栏覆盖全部数据公司。** 以前只有 AI 公司有缓存的申报列表，事件任务拿不到其他公司的 CIK；现在 CIK 也可以从申报发现状态里读到。未读完的 Form 4 不在已发布的事件栏里，所以还有待读时每次运行都重新读取申报列表，否则积压会卡住，这是旧代码就有的问题。
- **申报发现首次见到一家公司时只记录基线，不发事件。** 状态记在 `sec:discovery:v1:<代码>`，保留最近 200 份申报的 accession。
- **发布后的一次性全量运行。** 新任务第一次出现时会对所在范围的所有公司跑一次，相当于原来的每日重采；之后只由事件触发。

P4 的实现要点与差异：

- **Cron 只剩申报发现。** 要点、业务解读、业务脑图、财报记忆、公司分析不再轮询。
- **要点、业务解读、业务脑图**在输入变化时运行：先算当前指纹，与已发布版本相同就结束；不同才启动 Workflow，并每 5 分钟检查一次实例状态直到结束。业务解读、业务脑图订阅 `financials.published`（业务列表可能变化），要点订阅 `map.derived`、`guidance.published`、`fundamentals.updated`、`analysis.published`。
- **模型任务失败直接进死信，不自动重试。** 一次业务脑图要跑约半小时模型，按队列默认重试 5 次代价太高；失败的实例写入 `pipeline_dead`，由人在后台重放。原来的做法是每周按新实例 ID 重试一次。失败时同时记下这次的输入指纹（`pipeline:workflow-failed:<任务>:<代码>`），同一输入不再自动重跑，输入变化或在后台重放死信后才会再跑；上线时 NET 的业务脑图就是这种情况：素材里找不到可锚定的内容，两次运行都以同样原因失败。
- **要点的就绪条件**按设计实现：一天内的业绩 8-K 指引还在排队或提取时，30 分钟后再看；指引的 SEC 材料提取完成（`extracted`）即可，不等电话会文字稿。
- **财报记忆、公司分析是恢复任务。** 正常路径不变：SEC 财报工作流发布后直接排队记忆，记忆工作流直接启动公司分析。两个任务订阅 `report.published`（定期报告），负责启动没被启动的记忆任务、接手租约过期的任务、按原有的退避节奏（15 分钟、2 小时、8 小时，最多 3 次）恢复失败的公司分析，以及在提示词版本变化后重跑。

### 上线核验（2026-10-11 UTC）

- Cron 只剩 `*/10` 的申报发现：每次读取 10 家公司，心跳正常。删除 `*/2` 后约 20 分钟内仍有它的调用，是 Cloudflare 传播 Cron 变更的延迟，之后只在整 10 分钟运行。
- 模拟 ORCL 业绩 8-K 被重新发现：采集 → 发布 → 地图快照 → `map.derived` → 要点；SEC 财报工作流 → `filings.indexed` → 指引；事件栏、业务解读、业务脑图都按事件运行，指纹未变的直接结束。每一步在 `pipeline_log` 里能沿 `cause_id` 追溯。
- 全程无失败运行、发件箱无积压；唯一的死信是 NET 业务脑图（素材里找不到可锚定内容），与改造前同因失败。
- 旧存档里带 sec.gov 随机脚本的副本，在补历史重读时一次性改存为规范内容，1,170 个被替换的对象 24 小时后由 `archive-prune` 删除。
