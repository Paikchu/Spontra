# 线上对话：把 DeepSeek Harness 的用户、工具管理与报告生成搬到 Cloudflare，舞台即对话

状态：评估稿，2026-10-20。未实现。

线上要做的不是一个聊天框。交互模式是：公司页侧边栏不动，侧边栏之外的整个舞台随用户的话改变，用户和舞台沟通，而不是看一条条消息流。此外要接入用户；要 Harness 那套工具管理（注册、校验、允许/拒绝/询问、执行管线）；要 Harness 那套报告生成逻辑（证据留存、引用校验、原文保留、复评）。插件系统不要。本文按这四件事评估，先给结论。

## 结论

- 不迁 Harness 的运行时（启动、持久化、宿主、Web 客户端都是本机层，见"Harness 是什么"）。
- 工具管理：`@deepseek-ai/dsh-tools` 本身没有 node 依赖、已发布到 npm，可以作为库进 Durable Object；但线上的工具还要在 Workflow 的 `step.do` 里跑批处理，所以推荐**搬契约不搬运行时**：在 `workers/analysis/src/tools/` 实现一个与 Harness 同语义的注册表，对话 DO 与 Workflow 共用同一组工具定义。
- 报告生成：搬规则不搬存储。Harness 的报告规则全在 `tool-investment` 的三个工具里，线上用 D1 按 `user_id` 建表承接；SEC 证据线上已经有（filing library），只需补用户留存的网页证据。
- 交互：舞台是一份声明式的 Scene 文档，agent 用工具改它的修订版，客户端渲染后回执；用 Agents SDK 的状态同步而不是聊天协议。Harness 里 `InvestmentView` 的 revision / appliedRevision 和 `investment_screen_record` 的 expectedRevision 就是这个模式。
- 对话在 DO，生成在 Workflow，Workflow 完成后直接推给 DO，不轮询、不加 Cron。

## 现状

本地 app 是 deepseek-harness `main`（5f605ce，2026-10-19）的 `investment` 组合包：用户在 Harness 原版 Conversation 里发起对话，模型通过 25 个 `investment_*` 工具加 bash/fs/web/subagent 等标准工具工作，数据在本机 SQLite，模型是 DeepSeek。

线上 app 是 `spontra-business-map`（Vite + React SPA，Workers Assets）经 Service Binding `MapReads` 读 Spontra Analysis，全部是只读 GET。线上没有用户身份、没有流式通道、没有 Durable Object、没有 Agents SDK，模型只有 Anthropic Claude。模型工作都在 13 个 Workflow 里，用 `tool-loop.ts` 的契约（`AgentTool` / `AgentAct`，每轮最多 4 次调用，3 次坏回复停止）。

## Harness 是什么（对迁移而言）

| 层 | 事实 | 含义 |
|---|---|---|
| 框架 | Cordis 插件树，无 node 依赖 | 可以在 workerd 跑 |
| 核心循环 core/llm/session（约 47k 行） | 只用 `node:crypto`、`node:path`、`node:async_hooks`、`node:util/types` | `nodejs_compat` 下可用 |
| 工具注册表 `core/tools`（5.8k 行） | 依赖只有 brand、util-values、schemastery，Cordis 为 peer；无 `node:` | 可作库复用 |
| 启动 boot（51 个源文件，29 个依赖 `node:`） | 文件系统读 profile/bundle YAML、HMR、`dsh` 启动器 | 不要 |
| 持久化 | JSONL + 文件租约 + `worker_threads` + zstd；session-query SQLite | 不要 |
| 宿主 | `node:http` + `ws`，Remote RPC，loopback 信任围栏 | 不要 |
| Web 客户端 | 148k 行 Cordis client 插件，依赖十几个宿主 controller | 不可复用 |
| 模型适配 | `llm-deepseek`、`llm-pi-ai`；无 Anthropic | 线上只有 Anthropic key |
| 多用户 | 单 owner 本机应用；remote-access 是"owner + 访客"而非多租户 | 身份要自己做 |
| 版本 | 0.2.1-rc.2，pre-stable，PR 超过 6400 | fork 即漂移；作 npm 依赖要锁版本 |

## 一、用户

线上今天没有任何用户概念：公共 Worker 匿名，只有一个共享管理员口令换 8 小时 HMAC 会话；配额是全局日配额（`feature_budget`），限速按 IP。

要加的：

1. 身份：Cloudflare Access（内测最快，JWT 里拿 email）或自有账号（产品化）。两种都落为一个 `user_id`，业务代码不区分来源。
2. D1：`users`；`ai_usage`、`feature_budget` 加 `user_id`；配额与限速按用户。
3. 多租户用 Agents SDK 自己的结构，不手写 Durable Object：
   - `UserAgent`（`getAgentByName(env.UserAgent, userId)`）：一个用户一个实例，存对话目录、配额计数、偏好；
   - `StageAgent` 作为它的 sub-agent（`this.subAgent(StageAgent, conversationId)`）：一个对话一个实例，存舞台 Scene 与对话日志；
   - Worker 入口 `routeAgentRequest(request, env, { onBeforeConnect, onBeforeRequest, props: { userId } })` 校验身份后放行，并核对实例名与 `userId` 一致，跨用户不可寻址。
   Agents SDK 的 `Agent` 类本身就是 Durable Object（DurableObject → Server → Agent），这里说的 DO 都指它。
4. 管理后台：按用户看对话、用量、报告（已有 `ai-runs` 页面扩一列）。

## 二、工具管理

Harness `dsh-tools` 提供的，线上要的子集：

| Harness 能力 | 线上怎么落 |
|---|---|
| `defineTool`：zod 参数、输出 schema、`render` 成内容块 | 工具定义文件 `workers/analysis/src/tools/<name>.ts`，一处定义，DO 与 Workflow 共用 |
| 按 agent 的 `ToolRestriction`（allow/deny）与 `ToolGuard` | 每个场景一份白名单：对话、报告 Workflow、批处理分析师各自不同 |
| `tools/pre-execute` 决策 allow / deny / ask / cancel | 对话里 `ask` 走 Agents SDK 的人在回路确认；Workflow 里没有 `ask`，只有 allow/deny |
| `tools/post-execute` accept / block（可附反馈给模型） | 校验器放这里，例如报告引用校验失败返回 `block` 让模型改 |
| `timeoutMs`、`isConcurrencySafe` | 对话里并行安全的工具并发跑；Workflow 里每次调用一个 `step.do` |
| 普通工具失败不结束回合 | 沿用 `tool-loop.ts` 的 `toolResult(..., error)` |
| PTC 模式、`presentAs`、UI 呈现 | 不要 |

两条实现路径：

- 直接依赖 `@deepseek-ai/dsh-tools` + `@deepseek-ai/cordis`（锁 0.2.1-rc.2）。省写注册表，但 Spontra Analysis 里多出 Cordis 上下文，且工具执行还得包一层才能进 `step.do`。
- 自写注册表（约 400 行），接口照 `ToolDefinition` / `PreToolDecision` / `PostToolDecision` 的形状，执行器两个：DO 执行器（并发、可 ask）、Workflow 执行器（每次调用一个 `step.do`）。推荐这条，原因是线上工具必须能在 Workflow 里跑，而 `dsh-tools` 的运行时假定一个常驻 agent 进程。

两条路都要把现有 `tool-loop.ts` 的 `AgentTool` 改为从注册表导出，分析师、lens、checkup 三个已有 agent 不改语义。

## 三、报告生成

Harness 的报告逻辑在 `tool-investment` 三个工具加证据收集器里，规则如下，线上照搬：

- 证据留存（`evidence.ts`）：文档 id 由 来源、代码、URL、原文哈希、发布时间、期间 哈希而成；SEC 来源必须来自 `data.sec.gov` / `sec.gov` 才标 `verified`，网页文章一律 `unreviewed`；保留原始响应与可检索文本；失败或截断不覆盖完整文档。
- 写报告（`investment_report_record`）：引用的每份文档必须先留存并读过；至少一份本代码的 `verified` SEC 或 IR 文档；新报告的价格基线与表现为未知，不编价格；更新要带上次读到的 `contentHash`（CAS），`originalMarkdown` 永远保留；报告不能换代码。
- 读报告（`investment_report_read`）：原版与现版分开，按 offset 分块读。
- 复评（`InvestmentAssessment`）：状态 strengthened / unchanged / weakened / invalidated / insufficient-evidence / missing-reason，必须带 `counterEvidence` 与 `nextCheck`，引用具体文档与理由版本。
- 运行去重（`review.ts`）：`businessKey = 版本:业务日期:输入摘要`，同输入不重跑，租约防并发。

线上映射：

| Harness | 线上 |
|---|---|
| `investment_documents`（SQLite） | SEC 文档：filing library 已在 D1/R2，天然 `verified`；网页文档：新表 `user_documents(user_id, id, symbol, url, content_hash, verification, text→R2)` |
| `investment_reports` / `report_versions` | `user_reports`、`user_report_versions`，按 `user_id`，保留原版 |
| `investment_assessments` | `user_assessments` |
| `investment_runs`（businessKey、lease） | 直接用 Workflow 实例 id 加 `businessKey` 去重，死信进 `pipeline_dead` |
| `investment_notices` | `user_notices`，只有用户显式读过才 acknowledged |
| 本地 research 目录 | R2 前缀 `users/<user_id>/` |

存储放 D1 而不是 DO SQLite：报告跨对话、要被后台看、要按用户与代码查询；DO 只存对话记录与流状态。

执行分工：

1. 用户在对话里要报告 → DO 的 `report_generate` 工具校验配额后创建 `ReportWorkflow`，立即回"已开始"并把 Workflow id 写进对话。
2. `ReportWorkflow` 用同一组工具在 `step.do` 里跑 Harness 的流程：找 SEC 文档 → 留存 → 读 → 网页补证 → 写报告（post-execute 校验引用）→ 复评。
3. Workflow 结束调用 DO stub 推送结果，DO 向客户端广播；不轮询、不加 Cron。

## 四、交互模式：舞台即对话

今天的公司页是 `Rail`（侧边栏）+ `section.stage`，舞台里固定渲染 `BusinessMap`，子视图由 `?business=` / `?finding=` / `?metric=` 决定。要改成：侧边栏不动，舞台渲染一份由 agent 写的 **Scene**，用户在舞台底部的输入条说话，agent 的回答是舞台的下一个修订版，不是消息气泡。

### Scene 文档

沿用 `shared/analysis-contract/lens.ts` 的做法：声明式 grammar，模型只写引用，编译器算数据，读时校验，校验失败整块撤下。`LensDocument` 已经是 `rows → cells → prose | chart | figures | watch | sources`，Scene 在它上面加页面级块：

```ts
type SceneDocument = { revision: number; status: string; rows: SceneRow[] };
type SceneBlock =
  | LensBlock                                                       // prose / chart / figures / watch / sources，原样复用
  | { kind: "business-flow"; ticker; focus?: string }               // 现有 Sankey
  | { kind: "mind-map"; ticker; focus?: string }
  | { kind: "metric-trend"; ticker; ref: FindingRef; periods: number }
  | { kind: "findings"; ticker; ids?: string[] }
  | { kind: "filings"; ticker; accession?: string }
  | { kind: "events"; ticker; range?: ... }
  | { kind: "report"; reportId; version: "original" | "current" }    // 第三节的用户报告
  | { kind: "progress"; workflowId; label }                          // 报告生成中
  | { kind: "question"; text; options: string[] }                   // 对应 Harness 的 ask_user
  | { kind: "actions"; items: { label; prompt }[] };                 // 可点的追问
```

块只带引用不带数据，客户端照旧走 `MapReads` 取数并命中 60 秒缓存；DO 状态保持很小。现有视图组件（`BusinessMap`、`MindMap`、`MetricTrend`、`FindingsList`、`Timeline`、`ReportLens`、`LensPanel`）就是块的渲染器，不新写图表。

默认 Scene 等于今天的页面（一个 `business-flow` 块），用户不说话页面不变；说第一句话后舞台进入 agent 模式；侧边栏保留"回到地图"。

### 修订与回执（Harness 的模式）

- 工具 `scene_set(scene, expectedRevision)`：CAS，和 `investment_screen_record` 一样，模型带上次读到的修订号，过期就失败重读。
- 客户端渲染完成后回执 `appliedRevision`，和 `InvestmentView.appliedRevision` 一样只在真的渲染后才算应用。
- 工具 `scene_read()` 返回当前 Scene 与用户正在看的东西（可见块、选中的要点或指标、滚动到的位置），这是"沟通"的另一半：用户在舞台上的点击、悬停、选择作为事件发给 DO，agent 可以据此回应，对应 lens iframe 现有的 hover / focus 消息。
- 历史就是修订序列：前进后退翻修订，不翻消息。模型的上下文仍是 DO 里的完整对话日志（用户的话 + 工具调用 + 每次 Scene），只是不展示。

### 传输与流式

用 Agents SDK 的 `Agent` 类（不是 `AIChatAgent`，也不是裸 Durable Object）：Scene 是 `this.state`，`setState` 自动同步到所有连接的客户端，前端 `useAgent` 的 `onStateUpdate` 重渲染舞台。流式体现为渐进的修订：先放骨架块（`status: "读取 10-K"`），工具每返回一块就 `setState` 一次，不需要 token 级流。Workflow 生成报告时，`progress` 块显示进度，Workflow 结束调 DO 推送，`report` 块替换 `progress` 块。

### 校验

Scene 进状态前跑读时校验：lens 块走现有 `verifyLensDocument`；引用块检查 ticker 在白名单、finding / accession / ref 可解析；prose 数字走现有 `numberSupported`。校验失败的块撤下并以 `block` 反馈给模型，和第二节的 post-execute 一致。

## 五、可观测性

三层，各管一件事：

| 层 | 做什么 | 来源 |
|---|---|---|
| 不丢的记录 | 每个对话的完整日志：用户的话、工具调用与结果、每次 Scene 修订、模型用量 | `StageAgent` 自己的 DO SQLite 追加表，对应 Harness 的 session log；这是唯一无损的记录，trace 不是 |
| 业务账本与后台 | 每次模型调用一行 `ai_usage`，运行与步骤记录，后台按用户 / 对话 / 报告查看 | 现有 `recordAiUsage`、`AiRunStore`、`trackRun/trackSteps`，加 `user_id`、`conversation_id` 两列；Workflow 报告运行照旧进 Admin 的 ai-runs 页 |
| 平台 trace | 一次用户输入从 Worker → `StageAgent` → 模型 → 工具 → Workflow 的时间线，错误与耗时 | Workers 自动 tracing（`observability.traces.enabled`），Worker 到 DO、Service Binding、Workflow 的 RPC 已自动串成一条 trace；DO 实例 id 可过滤 |

Agents 控制台的"会话回放"对自写 harness 也可用：用 `tracing.enterSpan` 按 GenAI 语义约定打三种 span，`invoke_agent`（一回合）、`chat`（一次模型调用）、`execute_tool`（一次工具），带 `gen_ai.agent.name`（固定 `stage-agent`）、`gen_ai.agent.id`、`gen_ai.conversation.id`，以及 `gen_ai.input.messages` / `gen_ai.tool.call.arguments` 等载荷属性。实现上只需在 `callWorkerToolModel` 和注册表的执行器各包一层，分析师、lens、checkup 三个已有 agent 一并获得。

Agents SDK 自带的 diagnostics channel（`agents:state` 的 `state:update`、`agents:rpc`、`agents:lifecycle`、`agents:workflow`）在生产环境自动转发到 Tail Worker，不用在 agent 里写订阅；需要的话接一个 Tail Worker 落到 D1 或外部。

限制与决定：

- trace 载荷会截断，保留 7 天；2026-12-01 起计入 Observability 用量计费。无损记录靠第一层，不靠 trace。
- 载荷里有用户内容。默认只在 span 上记工具参数与结果，不记用户原话；要记用户原话需明确决定并写进隐私说明。
- 需要外部平台（Grafana、Honeycomb、Axiom）时开 OTLP 导出，`persist: false` 可只导出不在 Cloudflare 存。
- 本地 `wrangler dev` / `vite dev` 自动产生同样的 trace，Local Explorer 可看，开发期不用另搭。

## 推荐路线与否决的路线

- 否决 A（把 Harness 核心移植进 DO）：要重写的恰是变动最频繁的层，Web 客户端不可复用，等于只搬了循环还背一个 fork。
- 否决 B 作为产品路线（Harness 原样跑 Containers，每用户一容器）：每用户一个 Node 进程、IDE 式工作台、bash/fs/credentials 攻击面；只适合 1 到 2 周内给少量内测用户看 demo。
- 采用 C：原生 Agents SDK 对话 DO + 共享工具注册表 + Workflow 生成报告 + D1 按用户存储。工期 4 到 6 周。
- 补一条：Spontra Analysis 暴露 MCP（Streamable HTTP），本地 Harness 用现有 `mcp-client` 接入，本地与线上调同一组工具；IBKR、组合、本机文件类工具留本地。

## 待定的决策

1. 身份：Cloudflare Access 还是自有账号。
2. 线上对话与报告的模型：Claude（与线上一致）还是 DeepSeek（与本地一致，要新 key 与适配）。
3. 工具注册表：自写（推荐）还是依赖 `@deepseek-ai/dsh-tools`。
4. 报告是否允许用户编辑理由/计划（引入 `user_plans` 与理由版本），还是第一版只由模型生成、用户只读与追问。
5. 舞台历史是否要分享链接（Scene 修订落 D1 可分享，只落 DO 不可分享）。

## 分阶段

- P0 用户：身份、`users` 表、`user_id` 进 `ai_usage` / `feature_budget`、按用户限速、后台按用户看。
- P1 工具注册表：契约 + 两个执行器，现有三个 agent 迁到注册表，行为不变（快照测试）。
- P2 舞台：Scene 合同与校验、`StageAgent` DO（状态同步）、`scene_set` / `scene_read` 工具、只读工具（findings、fundamentals、filings、passages、web search）、舞台输入条与块渲染器复用现有组件、默认 Scene 等于今天的页面。
- P3 报告：`user_documents` / `user_reports` / `user_assessments` 表、`ReportWorkflow`、三个报告工具与引用校验、Workflow 完成推送 DO、报告页。
- P4 MCP server 与本地 Harness 接入。

## 安全边界

用户输入只进 prompt，不决定检索范围与工具白名单；工具结果视为数据不视为指令；`verified` 只由来源域名决定，模型改不了；每用户限速与日配额；DO 名带 `user_id`；报告写入前校验引用，校验失败以 `block` 反馈给模型而不是落库。
