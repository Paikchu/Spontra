# 线上舞台 Agent：改造需求与实施方案（评审后第 2 版）

状态：方案稿 v2，2026-10-21。评估与路线取舍见 [harness-online-chat-design.md](harness-online-chat-design.md)。本版吸收了一轮八视角评审（产品、前端架构、后端架构、Agent 设计、数据合同、安全、运维成本、交付），处理记录在附录。目标不变：另一位工程师不再做设计决定就能实施。

## 0. 相对第 1 版的改动

| 改动 | 原因 |
|---|---|
| 内部管线（队列、`driveWorkflow`、13 个 Workflow、发布步）本期不动；删除 `CompanyAgent`、`UserAgent` | `driveWorkflow` 承担失败阶梯重试、死信、重触发，`onWorkflowComplete` 替代不了；发布与 outbox 必须在同一 durable step 内同批提交；DO 类迁移不可回滚，不能与管线重写绑在一次上线 |
| "共用底层"改为：用户触发走 Agents SDK，事件触发维持 Workflow + 队列，两者共享工具注册表与循环；三个现有 agent 的迁移后置到舞台跑稳之后 | 先薄后厚，先交付用户价值，再统一 |
| `AnalysisFinding.lens` 类型不改，Scene 用 `{ kind: "lens", findingId, document }` 包装块引用要点文档；独立图表必须带 `periodEnd` | lens 块（judgment / figures / watch / sources / record / quote / table）都是"某条要点的"，没有锚点无法编译；现有 9 行、每格 4 块的文档不能被新限额撤下 |
| 前端先把 `BusinessMap` 拆成视图状态、侧边栏、舞台子树；视图状态与 Agent Scene 分两层并写明优先级；删除 `openFinding` callable | 今天 `BusinessMap` 同时渲染 Rail 与 `section.stage` 并持有八个 URL 参数，"替换 .stage 里的 BusinessMap"不成立；点开要点不能依赖 DO 连接 |
| lens iframe 不动；从 `LensPanel` 抽出 `LensBlocks` 组件给要点页与舞台共用 | iframe 只画一张 chart、不持有数据，不能渲染整份文档 |
| 删掉 Haiku 意图预分类；等待态由循环事件（流里第一个 `tool_use` 的名字）决定 | 每句话多 1 秒与一次调用，10% 误判会让舞台先变暗再复原 |
| 总开关与灰度名单放 D1 `business_feature_settings`，不放 wrangler var | 本仓库只能经 CI 部署，`--keep-vars` 会覆盖 Dashboard 改动，var 当不了"一键停" |
| 匿名 id 由服务端签发（Turnstile 后 HMAC），对话必须先登记，网关只暴露 `StageAgent`，未登记的实例名返回 404 | 客户端铸造的 id 不是边界；`routeAgentRequest` 会为任意名字建 DO 并暴露所有绑定的 Agent |
| 配额单位定为"一次模型调用"，加全局报告 / 检索 / 对话上限与按 IP 上限，起始值按账本给出 | 原 2,000 次/天是今天日均 180 次的 11 倍且报告与检索没有全局闸门 |
| DO 内回合硬预算：≤ 6 轮、≤ 2 分钟、只用本地读取工具；检索与读财报原文经 `run_recipe("research")` 进 Workflow | DO 驱逐不止来自空闲（每日 1–2 次发布、alarm 上限），12 轮 Opus 跑在 DO 里中断即全废 |
| 对话历史持久化为真实 `AgentMessage[]`，压缩只在 `say` 边界整批进行 | 滑动截断早期 tool_result 会逐轮击穿提示缓存 |
| 报告产物改为 Scene（lens 块），沿用 compile / verify / noEarlier；`reply` 改为带证据候选的段落 | 本仓库原则：模型不写数字、引文读时重验、每份分析引用更早财报并配图；自由 Markdown 绕过了这一切 |
| 报告最小集：两张表、四个工具；复评、通知、CAS、价格基线、版本表后置 | 线上没有行情来源，每人每天一份报告时复评不会发生，CAS 没有并发可解 |
| 状态同步拆为两条通道：`state` 只放 Scene，`turn` / `draft` / `transcript` 走 broadcast；块带稳定 id；回执协议写实 | 整包 `setState` 会让每次工具调用重渲染全舞台并重放入场动画 |
| 快捷键、Esc、底部空间、窄屏、焦点、刷新与多标签页、locale 全部按现有页面重写 | 原文与 `main.tsx` / `BusinessMap.tsx` / `style.css` 的实际行为冲突 |
| 分阶段改为 P0a → P0b → P1 → P2 → P3，每阶段写回滚手段；测试只写有运行器的断言 | 原 P0 是无用户价值的大爆炸；原第 11 节一半测试没有地方跑 |

## 1. 目标与边界

目标：线上公司页侧边栏不动，侧边栏之外的舞台随用户的话改变；用户能让 agent 读公司数据、查网页、生成一份有证据、数字可审计的研究报告。用户触发的回合与事件触发的要点生成共用同一个工具注册表、同一个循环、同一种舞台文档，只是触发方、执行位置与产物去向不同。

不做（本期）：

- 不接登录。身份是服务端签发的匿名 id；接登录时只换 id 来源。
- 不迁 DeepSeek Harness 的运行时、插件系统、Web 客户端；只搬它的工具契约、报告规则与"视图修订"模式。
- 不做消息流式聊天 UI，不用 `AIChatAgent`。
- 不加 Cron、不轮询；内部管线现有的 5 分钟队列重入保持原样，本期不改。
- 不改内部管线：队列路由、`driveWorkflow`、13 个 Workflow、发布步、outbox 本期一行不动。
- 用户不编辑报告正文；修订通过对话生成新版本。
- 舞台历史只留在对话内，不做分享链接。

已定的决策：

| 决策 | 取值 |
|---|---|
| 身份 | 匿名 id 由 business-map 在 Turnstile 通过后签发（HMAC 签名，含签发时间），存 localStorage；`user_id = "anon:" + id`。对话必须先经 `POST /agents/conversations` 登记，才有 `StageAgent` 实例 |
| 模型 | Anthropic Claude。`AI_TOOLS` 登记 `stage`（model `analysis`，Sonnet 级，effort low）、`stage-research`（`reasoning`，high）、`stage-report`（`reasoning`，high），后台可改 |
| 工具注册表 | 自写，接口照 Harness `dsh-tools` 的 `ToolDefinition` / `PreToolDecision` / `PostToolDecision`，加每次运行的状态槽 |
| 运行位置 | 舞台短回合在 `StageAgent`（Agents SDK `Agent`，即 Durable Object）内；检索、读原文、报告在 `AgentWorkflow` 内，由 `StageAgent.runWorkflow` 启动 |
| 存储 | 对话消息、Scene 修订在 `StageAgent` 自己的 SQLite；对话目录、用户运行、报告、证据、配额在 D1 按 `user_id`；要点发布物照旧在 `sec_cache` |
| 入口 | `spontra-business-map` 签发身份、限速、校验 Origin、转发；`spontra-analysis` 承载 agent、工具与 Workflow。新增第二个 Service Binding `SPONTRA_STAGE` 指向命名入口 `StageGateway` |
| 开关 | `FEATURES` 加 `stage`、`report`，运行时开关与灰度公司名单在 D1 `business_feature_settings`，后台"业务功能开关"组件各加一行 |

## 2. 架构：一套工具与循环，两个触发

```text
事件触发（现状不变）                                   用户触发（新）
队列 → driveWorkflow → Workflow（13 个）                浏览器 WS → business-map → StageGateway → StageAgent(conv)
   └─ lens / analyst / checkup：本期仍是各自的循环          ├─ 短回合：runAgentLoop(stage, agentExecutor)，≤ 6 轮
      P3 起逐个迁成 Recipe，用 workflowExecutor            └─ 长任务：this.runWorkflow(ResearchWorkflow | ReportWorkflow)
                                                               runAgentLoop(recipe, workflowExecutor)，step.do 持久化
                        ┌──────────────── 共享 ────────────────┐
                        │ 工具注册表 workers/analysis/src/tools/  │
                        │ 循环 workers/analysis/src/agent-loop.ts │
                        │ 合同 shared/analysis-contract/scene.ts │
                        │ 运行时 shared/analysis-runtime/scene/  │
                        └───────────────────────────────────────┘
产物去向：要点 → findings.v2 发布物（不变）；舞台 → StageAgent 的 Scene；报告 → D1 user_reports（Scene JSON）
渲染：要点页的 LensPanel 与舞台的 lens 块共用 LensBlocks；chart 仍在 lens-frame iframe 里画
```

执行器由触发方决定：事件触发一律 `workflowExecutor`；用户触发的短回合 `agentExecutor`，长任务 `workflowExecutor`。lens 配方留在 `FindingsWorkflow` 里跑，不进 DO。

### 2.1 循环与配方

`workers/analysis/src/agent-loop.ts`。配方按运行实例化，状态是闭包，不是纯函数：

```ts
export type Recipe<I, O, S> = {
  id: "stage" | "stage-research" | "stage-report" | "lens" | "analyst" | "checkup";
  model: keyof typeof AI_TOOLS;
  budget: { turns: number; wallMs: number };
  system(input: I): string;
  opening(input: I): AgentMessage[];
  open(input: I): S;                                   // 本次运行的状态：materials、candidates、last、used、hits…
  tools(state: S): ToolDefinition<unknown, unknown, S>[]; // finish / reply 也是普通工具，闭包持有 state
  settle(state: S, reason: "finished" | "budget" | "failed" | "interrupted"): O | null;
};
export type RunHandle = {
  reserve(): Promise<boolean>;        // 每轮前统一扣 feature_budget 与 user_budget
  record(turn: TurnRecord): void;     // AiRunStore 或 user_runs，由 trigger 决定
  span<T>(name: string, attrs: Attrs, fn: () => Promise<T>): Promise<T>;
  payloads: boolean;                  // 用户触发为 false：span 不记消息与参数正文
};
export async function runAgentLoop<I, O, S>(recipe: Recipe<I, O, S>, input: I, messages: AgentMessage[], act: AgentAct, executor: ToolExecutor<S>, run: RunHandle): Promise<LoopOutcome<O>>;
```

循环体与今天三个 agent 相同：一轮 ≤ 4 次调用；坏回复 3 次停；`messages` 只增不改；预算耗尽时调用 `settle(state, "budget")`。`messages` 由调用方持有：舞台跨 `say` 延续同一数组，Workflow 内每次运行新建。

### 2.2 执行器

```ts
export type ToolExecutor<S> = {
  run(calls: ToolCall[], ctx: ToolContext<S>): Promise<AgentBlock[]>;
  ask?(question: Question): Promise<string>;   // 只有 Agent 执行器实现；Workflow 执行器视为 deny
};
```

- `workflowExecutor(step, registry, policy)`：每次调用 `step.do("<recipe>-t<n>-<i>-<tool>")`。
- `agentExecutor(agent, registry, policy)`：并发安全的并行；`ask` 变成舞台 `question` 块并等待 `answer`。

### 2.3 现有三个 agent 的迁移（P3）

lens、analyst、checkup 在 P3 逐个迁成 Recipe，每个一个 PR，行为基线是现有 fake-act 测试（`lens.test.ts`、`analyst.test.ts`）。迁的是循环，不含 `plan.ts`、review 复核等循环外的步骤。迁移后 `FindingsWorkflow` 的 step 名序列保持不变或新旧并存一个版本。本期不做。

## 3. 身份、配额、开关

### 3.1 身份与授权

- 签发：首次打开对话层时，前端完成 Turnstile（managed），`POST /agents/identity` 在 business-map 校验 siteverify 后签发 `anon_id = base64url(ts || random128 || hmac)`，存 localStorage。脚本不能批量铸造；接登录时同一位置换成账号 id。
- 携带：HTTP 调用放 `x-spontra-anon` 头；WebSocket 握手放 `Sec-WebSocket-Protocol` 子协议值，business-map 验签后搬进头并从握手中删除，analysis 侧只读头。`anon_id` 不进 URL、不进日志。
- 对话登记：`POST /agents/conversations { ticker }` → business-map 限速、验签 → `StageGateway` 查开关与配额 → 写 D1 `stage_conversations` → 返回 `conversation_id`（128 位）。`StageAgent` 实例名就是 `conversation_id`。
- 授权：`StageGateway` 用只含 `StageAgent` 的 env 子集调用 `routeAgentRequest`，其他 Agent 永远不可从外部寻址；`onBeforeConnect` / `onBeforeRequest` 查 `stage_conversations`，实例名不在该 `user_id` 名下返回 404，不创建 DO。`StageAgent` 在首次激活时把 owner 写进自身 SQLite，之后所有 D1 工具的 `userId` 来自 owner 而不是请求头。
- Origin：business-map 对 `/agents/*` 的 Upgrade 请求校验 `Origin` 等于站点 origin（预览域单独列出），否则 403。

### 3.2 D1 表（迁移 `0034_stage.sql`，编号合并前重核为最后号 +1，不改名已合并文件）

```sql
-- Additive only. Stage conversations, per-user budgets and user-triggered runs.
CREATE TABLE stage_conversations (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, ticker TEXT NOT NULL, locale TEXT NOT NULL,
  created_at TEXT NOT NULL, last_at TEXT NOT NULL, turns INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'      -- active | archived | deleted
);
CREATE INDEX stage_conversations_user ON stage_conversations(user_id, last_at);
CREATE TABLE user_budget (
  day TEXT NOT NULL, user_id TEXT NOT NULL, feature TEXT NOT NULL,
  units INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id, feature)
);
CREATE TABLE user_runs (
  user_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, ticker TEXT NOT NULL,
  conversation_id TEXT NOT NULL, business_key TEXT NOT NULL, status TEXT NOT NULL,
  started_at TEXT NOT NULL, finished_at TEXT, result TEXT, error TEXT,
  PRIMARY KEY (user_id, id), UNIQUE (user_id, business_key)
);
CREATE INDEX user_runs_active ON user_runs(user_id, status);
CREATE INDEX user_runs_started ON user_runs(started_at);
ALTER TABLE ai_usage ADD COLUMN user_hash TEXT;        -- sha256(user_id)，不存原始 id；不可逆，注释写明
ALTER TABLE ai_usage ADD COLUMN conversation_id TEXT;
CREATE INDEX ai_usage_user ON ai_usage(user_hash, at);
```

`user_budget.user_id` 允许两类键：`anon:<id>` 与 `ip:<sha256(ip)>`，每次扣减同时扣两份。配额预留抽成 `reserveBudget(db, table, key, cap)` 一处实现（沿用 `analyst/workflow.ts` 的 `INSERT … ON CONFLICT … WHERE units<? RETURNING`），`feature_budget` 与 `user_budget` 共用。

### 3.3 配额与限速

单位：一次模型调用 = 一次 `callWorkerToolModel` = `ai_usage` 一行。`say` 开始时按本回合最大用量预留，回合结束按实际用量回填差额；预留不足时在进入模型前显示 notice。

| 项 | 每匿名 id / 天 | 每 IP / 天 | 全局 / 天（`feature_budget`） |
|---|---|---|---|
| 对话创建 `stage-conversations` | 5 | 20 | 200 |
| 舞台回合 `stage-says` | 20 | 60 | 无 |
| 模型调用 `stage-calls` | 120 | 400 | 300（起步，灰度期按账本放宽） |
| 研究任务 `stage-research` | 3 | 10 | 40 |
| 报告 `stage-reports` | 1 | 3 | 10 |
| 网页检索 `web-calls`（含 Claude `web_fetch` 回退） | 20 | 60 | 100 |

其他限制：每匿名 id 活跃对话 ≤ 20，超过时登记新对话前先淘汰最旧的（调其 `destroy()`）；WebSocket 消息每对话 20 条/分钟（`StageAgent` 内令牌桶，在扣配额之前执行）；边缘 `ratelimits` `AGENT_LIMIT` 按 IP 30 次/分钟只限 HTTP 与握手；排队中的报告实例全局 ≤ 10，超过直接拒绝不排队。

全局闸门耗尽时：进行中的对话可以继续当前回合，新回合与新对话拒绝并显示 notice；Admin 舞台页显示耗尽时间与用量前 10 的 `user_hash`，可封禁当天配额。

### 3.4 开关

`shared/analysis-contract/business-features.ts` 的 `FEATURES` 加 `stage`、`report`；`companyPolicyEnvironment` 解析进 `FEATURE_RESOLVED`，默认 `enabled.stage = false`，`tickers.stage` 默认等于 `SEC_AI_TICKERS`。`StageGateway` 在登记对话与转发前调用 `featureEnabled(env, "stage")` 与 `featureTickersFor(env, "stage")`，关着返回 503 + 原因码，不进 DO、不计费；`StageAgent.say` 每次也读一次，后台关掉后进行中的回合在下一轮终止。前端通过 `/api/business/v1/companies/:ticker/revision` 响应新增的 `features: { stage: boolean }` 得知开关（该路由已每 3 分钟轮询且 `no-store`），关着时不渲染入口按钮。

### 3.5 保留与删除

- 匿名对话及其 D1 / R2 数据保留 30 天。R2 对 `users/` 前缀配生命周期规则（对象到期删除，不需要代码）。
- 惰性清理：`POST /agents/conversations` 与 `say` 时顺手把该用户 30 天前的对话标 `archived` 并调其 `destroy()`；Admin 加"清理 N 天前匿名数据"动作（删 R2 前缀与 `user_*` 行）。
- `StageAgent` 增加 `@callable() delete()`：`destroy()` + 删除该对话的 `user_*` 行与 R2 对象；对话层给"删除对话"入口。
- 后台只展示 `user_hash`，不展示原始 anon id；对话内容可在后台按对话读取（3.6），用于排查。
- 对话层首次打开时显示一行事实陈述：对话内容保留 30 天，供改进分析质量时查看。

### 3.6 后台

- ai-runs 页加 `trigger` 列（枚举只做加法：`manual | schedule | event | user`）。
- 新增"舞台"页三层：列表（`stage_conversations`，可按 `user_hash` / ticker / 日期筛）→ 对话详情（新路由 `/admin/stage/conversations/:id` 经 `getAgentByName(StageAgent, id).history()` RPC 读 DO，显示每轮的 `ai_usage` 行与 Scene 修订、transcript 的只读 JSON）→ 操作（终止对话、封禁该 `user_hash` 当天配额）。
- 今日 / 本月 token 与调用数按 kind 从 `ai_usage` 汇总；全局配额余量；开关用现有组件。

## 4. 工具注册表

位置 `workers/analysis/src/tools/`。

```ts
export type ToolDefinition<A, R, S> = {
  name: string; description: string;
  parameters: z.ZodType<A>;            // 入参校验；JSON Schema 由 zod 生成
  strict?: boolean;                    // 默认 true；带整份文档的工具（compile / finish / report_record）显式 false，由 harness 校验
  output: z.ZodType<R>;
  observe(args: A, value: R, state: S): string;   // 给模型看的观察文本；预算行由循环追加，不由工具写
  execute(args: A, ctx: ToolContext<S>): Promise<R>;
  timeoutMs?: number;                  // 默认 60s
  concurrencySafe?: boolean;           // 默认 false
  budget?: "web" | "research" | "report" | null;  // 模型调用的扣减在 RunHandle.reserve，不在工具上
};
export type PreToolDecision = { kind: "allow" } | { kind: "deny"; reason: string } | { kind: "ask"; question: string };
export type PostToolDecision = { kind: "accept"; value?: unknown } | { kind: "block"; feedback: string };
export type ToolPolicy = { allow: string[]; pre?: (exec) => PreToolDecision; post?: (exec, result) => PostToolDecision };
export type ToolContext<S> = { env; userId; conversationId: string | null; ticker: string; locale: Locale; recipe: string; state: S; signal: AbortSignal; run: RunHandle };
```

本期注册表是一层薄适配器：`execute` 直接调用现有函数（`libraryRead`、`researchSearch`、findings 读取、`compileDocument`），不改 lens / analyst / checkup 的代码。`tool-loop.ts` 的 `AgentTool` 改由 `registry.schemas(policy)` 导出。

工具清单（P 列是上线阶段，pre 列是 stage 配方里的前置决策）：

| 工具 | 来源 | stage（DO） | research（WF） | report（WF） | pre | P |
|---|---|---|---|---|---|---|
| `scene_read` | 新：当前 Scene、作用域、最近观察到的视图 | ✓ | | | | P1 |
| `company_overview` | 包装 business-flow + explainer + guidance，登记证据候选 | ✓ | ✓ | ✓ | | P1 |
| `findings` / `finding_detail` | 包装 findings 读取，登记候选 | ✓ | ✓ | ✓ | | P1 |
| `fundamentals` | 包装 fundamentals，按 ref 取序列，登记候选 | ✓ | ✓ | ✓ | | P1 |
| `compile` / `finish` | 现有 lens，改为编译 Scene | ✓ | ✓ | ✓ | | P1 |
| `reply` | 新：`{ paragraphs: ExplainerClaim[] }`，数字过候选校验 | ✓ | | | | P1 |
| `run_recipe` | 新：启动 research / report Workflow | ✓ | | | `report` 需 ask | P2 |
| `find_sections` / `read_section` | 现有分析师工具 | | ✓ | ✓ | | P2 |
| `peers` / `similar_businesses` | 现有分析师工具 | | ✓ | ✓ | | P2 |
| `search` / `read_web` | 现有分析师工具；`read_web` 只收本次运行的 hit id | | ✓ | ✓ | | P2 |
| `evidence_retain` | 新：参数是 hit id 或 `sec:<accession>`，不收裸 URL | | | ✓ | 非 sec/IR 域需 ask | P2 |
| `document_read` / `evidence_search` | 新 | | | ✓ | | P2 |
| `report_record` / `report_read` / `reports` | 新，第 6 节；`report_record` 收 Scene 文档 | 读 | | ✓ | 更新已有报告需 ask | P2 |

`search` / `read_web` / `evidence_retain` 的结果进上下文时包在固定的 `<untrusted source="<host>">…</untrusted>` 标记里，系统提示引用这个标记。

## 5. 舞台与 Scene

### 5.1 合同

`shared/analysis-contract/scene.ts`。`LensDocument`、`LENS_LIMITS`、`AnalysisFinding.lens`、`DossierPublication.documents` 全部不动。

```ts
export type SceneDocument = {
  schemaVersion: "scene.v1";
  scope: { periodEnd: string; findingId?: string };    // 默认 = 最新发布报告期末
  basis: MapRevisions;                                  // 编译时读到的各资源修订
  rows: SceneRow[];                                     // ≤ 8
};
export type SceneRow = { title?: string; cells: SceneCell[] };     // 1–2 格
export type SceneCell = SceneBlock[];                               // 1–4 块
export type SceneBlock = { id: string } & (
  | { kind: "lens"; findingId: string; document: LensDocument }    // 一条要点的完整文档，复用 LensBlocks 与 verifyLensDocument
  | { kind: "chart"; periodEnd: string; chart: LensChart }         // 独立图表，periodEnd 必填
  | { kind: "prose"; paragraphs: ExplainerClaim[] }                 // 数字过候选校验
  | { kind: "business-flow"; focus?: string }
  | { kind: "mind-map"; focus?: string }
  | { kind: "metric-trend"; ref: FindingRef; span: FindingSpan; periods: number }
  | { kind: "findings"; ids?: string[] }
  | { kind: "filings"; accession?: string }
  | { kind: "events"; from?: string; to?: string }
  | { kind: "report"; reportId: string }
  | { kind: "progress"; runId: string; phase: "queued" | "running" }
  | { kind: "question"; questionId: string; text: string; options?: string[] }
  | { kind: "notice"; code: NoticeCode; params?: Record<string, string> }   // 文案由前端 messages() 渲染
);
export const SCENE_LIMITS = { rows: 8, cells: 2, blocksPerCell: 4, charts: 3, proseChars: 1_400 } as const;
```

- `revision`、`status`、`contentLanguage` 在 `StageState` 的信封里，不在文档里。
- 块 `id` 由服务端分配；draft 与 finish 之间同位置、同 kind、同引用复用同一 id，前端以 id 做 key。
- `shared/analysis-runtime/scene/`：`compileDocument(scene, ctx, resolver)` 是纯函数，`ctx = { publication, data, peers, locale, candidates }`，`resolver = { finding(id), accession(a), ref(r), report(id) }` 由调用方构造（Worker 从 D1 预取，前端从已读的 `CompanyData` 构造）；lens 块调现有 `verifyLensDocument`；chart 块按自带 `periodEnd` 编译；prose 用 `numberSupported(n, candidates)`；不通过的块撤下，整行为空时删行。`auditDocument`、`describeDocument` 同步扩展。
- 默认 Scene：`defaultSceneFor(view)`，一个 `business-flow` 块加视图状态，渲染结果与今天逐字节相同。
- `sceneOf(finding)`：把一条要点包成单个 `lens` 块的 Scene，作为聚焦要点时的起始舞台。

### 5.2 视图状态与 Scene 的两层

今天 `BusinessMap.tsx` 同时渲染 `Rail` 与 `section.stage`，并持有八个 URL 参数（business / finding / event / report / check / metric / view / detail）的状态。P1 第一步是拆分，不是新增：

- `company-view.ts`：`useCompanyView()`，URL 读写与 `pickBusiness` / `focusFinding` / `focusCheck` / `focusEvent` / `focusReport` 都在它里面。
- `Rail` 与 `StageBody`（今天 `section.stage` 的子树：LensPanel / MetricLens / ReportLens / EventLens / Timeline / TrendPanel）各自消费它。
- `Stage.tsx` 接管 `section.stage`：渲染 `sceneShown ? scene : defaultSceneFor(view)`；`business-flow` 块的渲染器就是 `StageBody`。

优先级规则（照 Harness `navigation.ts` 的"用户手势不被过期的 agent 修订覆盖"）：

| 情形 | 规则 |
|---|---|
| 视图状态 | 用户与 rail 拥有，纯客户端、零延迟、不经 DO、不扣配额；开关关闭、无连接、配额耗尽时与今天完全相同 |
| Agent Scene 在台上时点 rail | 视图立即生效，`sceneShown = false`，Scene 不丢；transcript 里对应条目带"显示"动作可回到 Scene；同时 `observe({ kind: "view", … })`（去抖 300 ms，纯状态写入，未连接时静默丢弃） |
| 回合进行中用户改了视图，之后 `finish` 到达 | Scene 写入状态但不自动上台，只追加 transcript 条目；用户未动视图时自动上台 |
| 刷新 | 视图从 URL 恢复，Scene 从 DO 恢复；`sceneShown = scene.revision > 0 && URL 无 finding / check / event / report` |
| `?c=` 指向不属于该用户或不存在的对话 | 去掉 `?c`，默认 Scene，notice `conversation-unavailable` |
| 聚焦要点时第一次 `say` | 服务端在 `say` 内以 `sceneOf(finding)` 为起始 Scene，不需要 callable |
| 窄屏"回到地图" | 与宽屏点 rail 同一条路径（`sceneShown = false`） |
| 舞台处于 agent 模式 | 舞台顶部有持久的模式标记与"回到地图 / 重置"控件，所有宽度可见 |

### 5.3 StageAgent

```ts
type StageState = { scene: SceneDocument; revision: number; applied: number; contentLanguage: Locale };   // setState 只在 commit 时
type TurnPhase = "thinking" | "answering" | "staging" | "running";
type TranscriptEntry =
  | { id; at; role: "user"; text: string }
  | { id; at; role: "assistant"; kind: "answer"; paragraphs: ExplainerClaim[]; contentLanguage: Locale }
  | { id; at; role: "assistant"; kind: "stage"; revision: number; status: string; contentLanguage: Locale }  // status 是模型写的，无前缀
  | { id; at; role: "assistant"; kind: "notice"; code: NoticeCode; params?: Record<string, string> };
type StageEvent =                                   // this.broadcast，不进 state
  | { type: "turn"; turn: { id; phase: TurnPhase; status: { tool: string; arg?: string } | null } | null }
  | { type: "draft"; draft: SceneDocument | null }
  | { type: "transcript"; entries: TranscriptEntry[] }
  | { type: "question"; question: { questionId; text; options? } | null };

export class StageAgent extends Agent<AnalysisEnv, StageState> {
  // SQLite：owner(user_id, ticker, locale)、messages(seq, role, content)、log(id, at, kind, payload)、scenes(revision, at, by, base_revision, scene)、turns(id, at, status, usage)
  @callable() async say(text: string): Promise<void>
  @callable() async answer(questionId: string, value: string): Promise<void>
  @callable() async applied(revision: number): Promise<void>        // 幂等；revision < 当前时忽略；多标签页以第一条为准
  @callable() async observe(event: StageObservation): Promise<void> // 视图变化、选中要点 / 指标、数据修订变化
  @callable() async cancel(): Promise<void>
  @callable() async history(offset: number, limit: number): Promise<SceneSummary[]>
  @callable() async show(revision: number): Promise<void>           // 回到某修订（作为新修订提交，by: "show"）
  @callable() async delete(): Promise<void>
  async onWorkflowProgress(name, instanceId, progress)               // progress 块 queued → running
  async onWorkflowComplete(name, instanceId, result)                 // research：结果作为 tool_result 进下一轮；report：progress → report 块
  async onWorkflowError(name, instanceId, error)                     // progress → notice
}
```

Scene 只有一个写入口：`commit(next, { expectedRevision, by: "finish" | "workflow" | "show" | "recover" })`，不匹配抛 `RevisionConflict`。`finish` 以回合开始时 `scene_read` 返回的 revision 为 `expectedRevision`，冲突时把最新 Scene 作为 tool_result 回给模型再写一次（最多一次）。Workflow 结果到达时若 `turn !== null`，排进 `pendingResults`，回合结束的 commit 之后合并。

#### 一个回合

1. `say`：令牌桶 → 开关 → `reserve`（预留 6 轮 + 回填）→ 写 `messages`（user：用户的话 + `scene_read` 摘要）与 transcript → broadcast `turn: thinking`。
2. `runAgentLoop(stageRecipe, …, messages, act, agentExecutor)`，硬预算 ≤ 6 轮、墙钟 ≤ 120 s，白名单只有本地读取工具 + compile / finish / reply / run_recipe。
3. 等待态由循环事件决定：`callWorkerToolModel` 增加 `onToolUseStart(name)` 回调（流里第一个 `tool_use` 块），`agentExecutor` 据此 broadcast `phase`：`compile` → staging，`reply` → answering，`run_recipe` → running。每次工具调用 broadcast `status: { tool, arg }`，前端经 `messages()` 渲染。
4. 通过校验的 `compile` broadcast `draft`（有 errors 的不发）。
5. 终止：`reply` → transcript(answer)；`finish` → `commit` + transcript(stage)；`run_recipe` → `this.runWorkflow(...)`、舞台放 `progress` 块（经 commit）、transcript(notice)；`ask` → question，等待 `answer`。
6. 循环收尾（任何终止方式、预算耗尽、中断）统一 broadcast `draft: null`、`turn: null`，写 `turns` 与 `user_runs`，回填配额。
7. 每轮结束把该轮的 assistant 消息与 tool_result 追加进 `messages` 表；`onStart` 发现上次 `turn !== null` 时标 `interrupted`，退还该回合未用配额，transcript(notice)，不自动重跑。`keepAliveWhile` 包住回合，但它是实验 API，预算不依赖它。

#### 历史与压缩

`messages` 表保存真实的 `AgentMessage[]`（含 thinking 与 tool_result），每次 `say` 追加一条 user 消息，循环在同一数组上继续，缓存前缀不变。压缩只在 `say` 边界整批进行：工具结果超过 80 条时，把最后 3 轮之前的全部消息替换为一条 harness 写的摘要 user 消息（当前 Scene 描述、已登记材料与候选的索引、最近 6 条 transcript），`log` 记 compaction 事件。预算按 token 估算（`inputCharacters` 已在 metrics 里），开场材料 + 历史 ≤ 30k token。

#### locale

对话登记时记录 `locale`（来自 `?lang`，与站点一致），进入 `StageState`、`ToolContext`、配方 system（固定句式 reason in English, answer in {locale}，术语表同一份 `glossary.ts`）。每条 transcript 与 Scene 信封带 `contentLanguage`，前端据此打 `lang` 属性。

#### 证据候选与 reply

`company_overview` / `findings` / `finding_detail` / `fundamentals` / `scene_read` 的执行结果把解析出的每个 `ResolvedEvidence` 登记进本回合 `state.candidates`（与 analyst 的 Materials 同一模式）；`compile` 与 `reply` 都用这个集合校验 prose 数字。`reply` 的段落不通过时以 `block` 反馈给模型，不进 transcript。数字问答优先用 `metric-trend` / lens `figures` 块回答，文字只做解释。

### 5.4 前端

客户端代码放 `packages/web/src/stage/`，business-site 用 `lazy(() => import(...))` 加载；默认页主包不含 `agents/react`，`vite build` 后主入口 gz 体积与改造前相差 ≤ 1 KB，stage chunk 单独计量。

| 文件 | 职责 |
|---|---|
| `company-view.ts`（business-site） | 视图状态 store，从 `BusinessMap` 拆出 |
| `Stage.tsx` | 接管 `section.stage`；`sceneShown ? scene : defaultSceneFor(view)` |
| `blocks/LensBlocks.tsx` | 从 `LensPanel` 抽出的文档渲染器（rows / cells / judgment / figures / quote / table / chart），要点页与舞台共用；chart 仍经 `LensFrame` iframe |
| `blocks/*.tsx` | 其他块：`StageBody`（business-flow）、`MindMap`、`MetricTrend`、`FindingsList`、`Timeline`、`UserReportBlock`（新，不复用 `ReportLens`） |
| `StageSkeleton.tsx` | 首个 draft 画骨架；之后只在行数变化时更新 |
| `AskButton.tsx` | 入口按钮：宽屏在侧边栏底部，窄屏在顶栏图标区 |
| `AskOverlay.tsx` | 渐变区 + 输入框 + transcript；状态机在 `overlay-state.ts`（纯模块） |
| `useStage.ts` | 只在用户打开对话层或 URL 带 `?c=` 时挂载 `useAgent`；`closed` 且空闲 5 分钟后 `close()`；`state` 与 broadcast 分别进两个 React state |
| `transitions.ts` | 时序常量；三套 reduced-motion 机制统一从这里读 |

数据：块只带引用。前端收到 Scene 先用现有 `resourcesToRead(shown, basis)` + `readResource` 把落后的资源读到 `basis` 修订再渲染，读不到的块才撤下；`events` / `findings` / `metric-trend` 从页面级 `CompanyData` 解析，不逐块 fetch；每次 `CompanyData` 变化在客户端重跑同一份校验并 `observe({ kind: "data", revisions })`。用户报告与证据走私有路由 `/agents/reports/:id`（验签、`cache-control: no-store`、不进 `cache.put`）。

回执协议：每个块渲染器实现 `onSettled(id)`（数据到达或撤下、iframe `lens:rendered` 或 fallback 画出）；`Stage` 在所有块 settled 或 3 s 超时后发一次 `applied(revision)`，超时在 transcript 记 `partial`；由回执触发的过渡只在 `revision === scene.revision` 时执行，新的 draft / finish 到达时取消未完成的过渡计时器。

性能：`useMemo(() => scene, [revision])`；块渲染器 `memo` 并按 `(id, revision)` 比较；`verifyLensDocument` 结果按 `(findingId, revision, data)` 缓存；`turn.status` 更新不触碰 scene 树。

文案：所有前端字符串进 `messages()` 表并过 `check:i18n`；服务端只发代码（`status: { tool, arg }`、`notice.code`），前端渲染；模型产出的 `status` 文本与回答按 `contentLanguage` 打 `lang`，不加任何前缀。

### 5.5 交互与动效

布局：`Rail` 不动；对话层固定在视口底部居中，宽度 `min(720px, 100vw − 32px)`，叠在舞台之上，但舞台为它预留空间：`AskOverlay` 暴露 `--ask-h`，`.stage { padding-bottom: var(--ask-h); scroll-padding-bottom: var(--ask-h) }`。底部只有一个槽位：`update-notice` 与对话层同时出现时，notice 升到对话层之上。

对话层状态（`overlay-state.ts`，state × event → state）：

| 状态 | 外观 | 进入 |
|---|---|---|
| `closed` | 不渲染，不连接 | 初始；`mini` 态再按 Esc |
| `open` | 渐变区展开，高度 ≤ 40vh，transcript 可滚动，输入框聚焦 | 点入口按钮；快捷键 `⌘J` / `Ctrl+J`（`aria-keyshortcuts` 标在按钮上）；点 `mini` 态 |
| `busy` | 同 `open`，输入禁用，底部一行状态（`messages()` 渲染的 `status`）；`answering` 时 transcript 末尾打字指示 | `turn !== null` |
| `mini` | 只剩输入框与最近一条 assistant 条目，渐变区约 96 px | 舞台 `applied` 后；Esc；点击或滚动舞台 |
| `disconnected` | 输入禁用，状态标签，无骨架 | `useAgent` 重连中 |

快捷键与焦点：`/` 留给搜索；Esc 单一归属，对话层只在焦点在其内部时处理 Esc 并停止冒泡，焦点在舞台上时 Esc 保持今天的含义。完成时不移动 DOM 焦点：对话层收成 `mini` 是视觉上把注意力交还舞台，输入框保持可聚焦且不失焦，用户可以直接继续输入；新 `status` 经现有 `aria-live` 区域读出一句；舞台滚到顶部只在用户自上次发送后没有滚动过时执行。

一次 `stage` 回合的时序（常量在 `transitions.ts`）：

1. 发送：用户条目入栈（上滑 + 淡入 160 ms），输入清空并禁用，状态行显示"思考中"标签（`messages()`）。
2. 第一个 `tool_use` 是 `compile` → `staging`：顶端出现不定长进度线。舞台当前内容保持不变、可交互，不变暗。
3. 第一个通过的 `draft`：按行列画骨架，与当前内容交叉淡入（200 ms）；之后只在行数变化时更新骨架。
4. `finish`：骨架逐个换成真实块，按行从上到下、同行从左到右错开 60 ms 淡入；数据块先占位再填充。
5. 所有块 settled → `applied(revision)` → 对话层进入 `mini`；焦点不动。
6. `mini` 态下点输入框或按 `⌘J` 回到 `open`。

`answer` 回合：舞台不动，transcript 末尾打字指示，回答淡入，对话层保持 `open`。`research` / `report` 回合：舞台放 `progress` 块（`queued` / `running` 两态，含取消），对话层进 `mini`；完成时 research 结果进下一轮由模型决定舞台，report 的 `progress` 块原位换成 `report` 块（淡入 300 ms）并追加 notice 条目。

窄屏（≤ 960 px，侧边栏即整页）：入口按钮在顶栏图标区；对话层是底部抽屉，高度用 `visualViewport` 计算以避开软键盘；`staging` 时舞台接管视口，顶部保留现有 sticky chip 行与"回到地图"。

通用规则：`prefers-reduced-motion` 下只保留不透明度变化；动画只用 `opacity` 与 `transform`；任何阶段出错，舞台恢复为上一修订（`commit(by: "recover")`）并发 notice，不留骨架；两个标签页共享一个对话，`applied` 与 `answer` 按 revision / questionId 幂等。

## 6. 研究与报告

### 6.1 研究任务（P2）

`run_recipe("research", question)` → `StageAgent.runWorkflow("RESEARCH_WORKFLOW", params, { id: sha256(businessKey).slice(0, 32) })`。`ResearchWorkflow extends AgentWorkflow<StageAgent>`：`runAgentLoop(researchRecipe, …, workflowExecutor)`，≤ 10 轮，工具见第 4 节；结果（登记的材料、候选、摘要）经 `step.reportComplete` 回到 `StageAgent.onWorkflowComplete`，作为下一轮的 tool_result 进入 `messages`，由 stage 配方决定舞台。

### 6.2 报告（P2 最小集）

D1（迁移 `0035_user_research.sql`，全部列带类型与 NOT NULL / DEFAULT，头注释 Additive only）：

```sql
CREATE TABLE user_documents (
  user_id TEXT NOT NULL, id TEXT NOT NULL,            -- id = sha256(source, symbol, url, publishedAt, period)
  symbol TEXT NOT NULL, source_type TEXT NOT NULL,    -- sec | ir | web
  url TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', published_at TEXT, retrieved_at TEXT NOT NULL,
  content_hash TEXT NOT NULL, bytes INTEGER NOT NULL, truncated INTEGER NOT NULL DEFAULT 0,
  verification TEXT NOT NULL,                          -- verified | unreviewed
  text_key TEXT NOT NULL,                              -- R2: users/<user_id>/documents/<id>.txt
  PRIMARY KEY (user_id, id)
);
CREATE INDEX user_documents_url ON user_documents(user_id, url);
CREATE TABLE user_reports (
  user_id TEXT NOT NULL, id TEXT NOT NULL, parent_id TEXT, symbol TEXT NOT NULL, company TEXT NOT NULL,
  locale TEXT NOT NULL, report_date TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  content_hash TEXT NOT NULL,                          -- sha256(scene JSON)
  scene_key TEXT NOT NULL,                             -- R2: users/<user_id>/reports/<id>/v<version>.json
  source_urls TEXT NOT NULL, run_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX user_reports_symbol ON user_reports(user_id, symbol, created_at);
```

规则：

- 报告产物是 `SceneDocument`，只用 lens 类块（prose / quote / table / chart / figures / sources）；report 配方沿用 analyst 的 compile（`verifyLensDocument` + `auditDocument` + `noEarlier`）与 finish；`report_record` 收 document 不收 markdown，落库前再跑一次 verify；需要 Markdown 时由渲染器导出。
- `evidence_retain(hit | "sec:<accession>")`：URL 只能来自本次运行 `search` 的命中、SEC 引用或公司档案 `ir_domains`（新增列，后台维护，精确主机名）；`sec.gov` / `data.sec.gov` / IR 域标 `verified`，其余 `unreviewed`；读 body 时就截断到 2 MB 并记 `truncated`；截断的抓取不覆盖已有完整文档（按 `(user_id, url)` 查）。网页正文注册为 `kind: "web"` 的 material（复用 `Materials.registerWeb` 与 `stripInstructions`）。
- `report_record`：每个 `documentId` 必须已留存且本次运行读过；至少一份本 `symbol` 的 `verified` SEC / IR 文档；至少一条来自更早财报的引文（`noEarlier`）；`symbol` 不能改。任一不满足返回 `block`，不落库。
- 修订：新 `user_reports` 行，`parent_id` 指向旧行，`version + 1`，天然保留原版；不做 CAS。
- 去重：`businessKey = report-v1:<user>:<symbol>:<day>:<sha256(question)>`，Workflow 实例 id 取其 sha256 前 32 位，`user_runs(user_id, business_key)` 唯一，`run_recipe` 对已存在的运行返回其 `runId`。
- `ReportWorkflow extends AgentWorkflow<StageAgent>`：`context` → `runAgentLoop(reportRecipe, …, workflowExecutor)` ≤ 16 轮 → `review`（只删不加）→ `step.reportComplete({ runId, reportId, contentHash })`。用户触发的运行失败不走 1h / 6h / 24h 阶梯，`onWorkflowError` 直接 notice 并退还配额。
- 后置（触发条件写明）：复评与 `user_assessments`（出现用户要求复评的真实对话 ≥ 10 次）、通知表、价格基线、MCP。

### 6.3 舞台上的表现

`run_recipe` 返回后 `commit` 一个 `progress` 块；`onWorkflowProgress` 第一次到达时 `queued → running`；`onWorkflowComplete` 把 `progress` 原位换成 `report` 块（不经模型）；后续动作是标签按钮直接调 callable（看证据、修订），不把模板文字注入为用户发言。

## 7. 安全

- 用户输入只进 prompt；工具白名单、检索范围（`search.domains` 只接受后端白名单内的域）、`verified` 判定、`read_web` / `evidence_retain` 的 URL 来源都不由输入决定。
- 不可信内容用 `<untrusted>` 标记进上下文；`run_recipe("report")`、更新已有报告、留存非 SEC / IR 域文档三处在 stage 配方里返回 `ask`，用户点确认后执行；Workflow 执行器里 `ask` 视为 `deny`。
- `question.text` 与按钮标签限 200 字符；前端点击时发送的正文必须等于用户看到的全文。
- `workers/analysis/wrangler.jsonc` 加 `global_fetch_strictly_public`；用户触发的配方禁用 Claude `web_fetch` 回退，或每次回退计入 `web-calls`。
- 授权与 Origin 见 3.1；`x-spontra-anon` 只在 binding 上信任；R2 键前缀 `users/<user_id>/`，读取时校验前缀。
- 模型调用加 `metadata.user_id = sha256(user_id)`。
- 全局闸门、开关、Turnstile 与对话登记是费用与滥用闸门；超额只停新回合与新对话，不停内部 Workflow。

## 8. 可观测性

- analysis 的 trace 已开（采样 5%）。`StageGateway` 用 `tracing` API 对 `/agents/*` 强制采样 100%；business-map 加 `traces.enabled` 同样只对 `/agents/*` 100%。
- span：`callWorkerToolModel` 包 `chat`，执行器包 `execute_tool`，`runAgentLoop` 每轮包 `invoke_agent`；属性 `gen_ai.agent.name = <recipe>`、`gen_ai.agent.id`、`gen_ai.conversation.id = sha256(conversation_id)`、token 数、耗时、输入 / 输出字节数。用户触发的运行（`RunHandle.payloads = false`）不记 `gen_ai.input.messages` / `gen_ai.output.messages` / `gen_ai.tool.call.*`；事件触发的运行可记。
- `recordAiUsage` 写 `user_hash`、`conversation_id`；用户触发的运行记在 `user_runs` 与 `StageAgent` 的 `turns`，不进 `sec_cache` 的 AiRunStore。
- 无损记录是 `StageAgent` 的 `messages` / `log` 表；trace 只做排查。
- 告警：为结构化日志事件 `pipeline-dead`、`stage-cap-exhausted`、`stage-turn-interrupted` 配置 Cloudflare Notifications 到邮箱；Admin 加「死信」页复用 `admin/pipeline.ts` 的列表与 replay（可后置）。
- `anon_id` 不进 URL、不进日志。

## 9. 配置变更

`workers/analysis/wrangler.jsonc`（分两次提交，见第 10 节）：

```jsonc
"durable_objects": { "bindings": [{ "name": "StageAgent", "class_name": "StageAgent" }] },
"migrations": [{ "tag": "stage-v1", "new_sqlite_classes": ["StageAgent"] }],
"workflows": [ /* 现有 13 个 */,
  { "name": "spontra-research", "binding": "RESEARCH_WORKFLOW", "class_name": "ResearchWorkflow", "concurrency": { "limit": 2 } },
  { "name": "spontra-report", "binding": "REPORT_WORKFLOW", "class_name": "ReportWorkflow", "concurrency": { "limit": 2 } }],
"compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"]
```

`apps/business-site/wrangler.jsonc`：`services` 加 `{ "binding": "SPONTRA_STAGE", "service": "spontra-analysis", "entrypoint": "StageGateway" }`；`run_worker_first` 加 `/agents/*`；`ratelimits` 加 `AGENT_LIMIT`；`observability.traces.enabled`；vars 加 `TURNSTILE_SITE_KEY`，secrets 加 `TURNSTILE_SECRET`、`ANON_HMAC_KEY`。`handle()` 在 `/api/*` 之前加 `/agents/*` 分支：Origin 校验 → `AGENT_LIMIT` → 验签 → `return env.SPONTRA_STAGE.fetch(request)` 原样返回，不经 `json()`、不重包头；在 `wrangler dev` 下验证 WebSocket 升级透传后再合并。

CSP：`public/_headers` 与 `worker/index.ts` 的 `security` 两处同步，`connect-src 'self' wss://<站点主机名>`，`script-src` / `frame-src` 加 `https://challenges.cloudflare.com`。

依赖：根 `package.json` 以精确版本加 `agents`（合并时取发布满两周的最新版），升级单独 PR 并附 `wrangler deploy --dry-run --outdir` 的 Total Upload 与 `startup_time_ms` 对比。`check:analysis:boundary` 不需要改。

## 10. 分阶段、验收与回滚

| 阶段 | 内容 | 验收（可测） | 回滚 |
|---|---|---|---|
| P0a DO 落地（0.5 周，单独推送） | `agents` 依赖；空的 `StageAgent` 类；DO 绑定与 `stage-v1` 迁移；`FEATURES` 加 `stage` / `report`，默认关；traces 配置 | CI 部署成功；线上无任何行为变化；dry-run 的 Total Upload 与 `startup_time_ms` 记录在案 | 不 revert（DO 迁移不可回滚）；类永不删除；回滚手段是开关 |
| P0b 共享底层（1 周） | 工具注册表（薄适配器）；`runAgentLoop` 与两个执行器；Scene 合同与 `scene/` 运行时；`LensBlocks` 抽出并由 `LensPanel` 使用；`BusinessMap` 拆分出 `company-view.ts` / `Rail` / `StageBody`；`0034_stage.sql` | lens / analyst / checkup 代码不变、测试不变；`defaultSceneFor(view)` 对八个 URL 参数的每种组合 `renderToStaticMarkup` 与拆分前相同；要点页 DOM 快照一致；线上 findings:v2 与 dossier:v1 全部文档经 `LensBlocks` 渲染撤块数为 0 | 纯重构，revert 即可 |
| P1 舞台最小版（2 周） | 身份签发与 Turnstile；对话登记；`StageGateway`；`StageAgent` 的 say / applied / cancel / observe；stage 配方（compile / finish / reply，本地读取 7 个工具）；块：business-flow、metric-trend、findings、lens、prose、chart、notice；对话层 closed / open / busy / mini / disconnected；骨架与过渡；配额；Admin ai-runs 加列、舞台页列表与开关 | `STAGE_TICKERS=ORCL` 灰度下固定 20 句 stage 问句 ≥ 16 句得到通过校验的非默认 Scene；10 句 answer 问句 revision 不变且 reply 数字全部有候选；开关关闭时 `/agents/*` 返回 503 且页面与今天一致、全部 rail 导航可用；Scene 在台上时点 rail 立即切到视图并可一键回到 Scene；回合中改视图后到达的 finish 不自动上台；刷新与第二个标签页恢复同一对话；超配额显示 notice 且 `ai_usage` 无新行；主包体积差 ≤ 1 KB；Safari / Firefox / Chrome 各一次 WS 连通 | 关 `stage` 开关；入口按钮随 `/revision` 的 flag 隐藏 |
| P2 研究与报告（2 周） | `ResearchWorkflow`、`ReportWorkflow`；`run_recipe` 与 ask；证据与报告工具；`0035_user_research.sql`；`UserReportBlock` 与私有路由；对话详情后台页 | 无 verified SEC 文档或无更早财报引文时 `report_record` 返回 block；含注入句的网页读入后不出现未经 ask 的 `run_recipe`；Workflow 结束后舞台 10 s 内换成报告块；同问题当天第二次 `run_recipe` 返回已有 runId；后台能按对话看到每一步 | 关 `report` 开关；报告配额设 0 |
| P3 统一底层（后置） | lens → analyst → checkup 逐个迁成 Recipe，每个一个 PR | fake-act 测试基线不变；step 名序列不变 | 单个 PR revert |
| P4 后置 | 复评与通知、登录（Cloudflare Access hostname 型，Worker 级不支持 WebSocket）、MCP、死信后台页 | 以后单独写 | |

P0a 到 P2 约 5.5 周。每阶段单独合并上线；D1 迁移只增表不改旧表语义，`ALTER TABLE ai_usage ADD COLUMN` 不可逆，在迁移注释里写明。

## 11. 测试

- `node --test`（`test:analysis`）：注册表（策略、超时、并发、block、ask→deny）、`runAgentLoop`（预算、坏回复、settle、压缩边界）、`compileDocument` 对引用块与 resolver、报告规则每条拒绝路径、`reply` 带未登记数字被拒、配额预留与回填、身份验签。
- 快照：stage / research / report 配方的 system、tool schema、opening JSON 固定在 `workers/analysis/test/snapshots/`，en 与 zh-CN 各一份；用 node:test 的 snapshot（先确认 Workers Builds 的 Node 版本并 pin）。
- Workflow：假 `act` 跑完整 report 配方，断言步骤名序列与落库结果。
- 前端（`test:business-site`，node:test，无 DOM）：`overlay-state.ts` 每条边一个用例（含 Esc 归属、两标签页、disconnected）；`defaultSceneFor` 与拆分前 `renderToStaticMarkup` 比对；优先级规则状态表（rail 点击 × sceneShown × turn 阶段 × finish 到达）；`applied` 时序用纯函数（settled 计数 → 是否发出）；`check:i18n`。
- 手动脚本（放 `scripts/`，不进 CI）：wrangler dev + Playwright 跑 20 句 stage / 10 句 answer 评测并记录结果与日期到 docs；并发 20 连接 × 5 回合的 DO 负载记录 CPU 与 `ai_usage`。
- 上线前按 AGENTS.md 执行 `analysis:typecheck`、`analysis:check`、`check:analysis:boundary`、`build`。

## 12. 风险

| 风险 | 对策 |
|---|---|
| DO 迁移不可回滚；删除类会销毁实例数据 | P0a 单独上线，类永不删除、不改名；回滚靠开关 |
| 配额被当作拒绝服务武器 | 服务端签发身份 + Turnstile；对话须登记；全局 / IP / id 三层；耗尽只停新回合 |
| 回合中 `StageAgent` 被驱逐 | ≤ 6 轮 / 120 s；每轮持久化消息；中断退还配额并 notice；`keepAlive` 是实验 API，不依赖 |
| 费用：Opus 跑舞台 | stage 配方默认 `analysis` 模型；全局 300 次/天起步；Admin 按 kind 看 token |
| 抽循环时改变三个现有 agent 行为 | 本期不迁；P3 逐个迁，fake-act 测试做基线 |
| Scene 校验过严导致舞台空白 | 兜底默认 Scene + notice；lens 块复用现有校验与 `documentFromEvidence` 思路 |
| 对话过长压缩后模型丢失早期材料 id | 压缩摘要带材料与候选索引；只在 `say` 边界压缩 |
| `agents` 包两周内多次发版 | 精确版本；升级单独 PR 附体积与启动时间对比 |
| 匿名数据无限增长 | 30 天保留；R2 生命周期；惰性清理 + 后台动作；`delete()` |

## 13. 实施记录（2026-10-21）

P0a 到 P2 已上线。P3、P4 仍按第 10 节后置，未开工。

| 阶段 | 提交 | 上线验收 |
|---|---|---|
| P0a | 393642b | 两个 Workers Builds 通过；地图读取无变化 |
| P0b | fa1c907 | 迁移 0035 在生产应用；lens / analyst / checkup 测试不变 |
| P1 | 29d3bb4、6dc0e9f，修复 88599ff、611cdfd | 20 句 stage 问句 19 句上台；10 句 answer 问句全部只回复不改舞台；回合 4–13 s；超配额显示 notice 且无模型调用；rail 优先、显示恢复、刷新恢复、手机布局在浏览器验证 |
| P2 | 64c4001、5c8cdcc | 报告请求先提议、读者点"开始"后才启动；Workflow 约 2 分钟、10 次模型调用完成，进度块换成报告块；报告在页面复核通过，引用本季 10-Q 与更早的 2026-02 10-Q；同日同问题再次开始复用同一 run（`user_runs` 只有 1 条 report） |

与正文的出入：

- `BusinessMap` 没有拆分，改为接收 `stageOverride` 等属性；默认视图渲染因此不变。
- 报告用普通 `WorkflowEntrypoint`，结束时经 RPC 通知 `StageAgent`，未用 `AgentWorkflow`。
- 没有单独的 ResearchWorkflow；深度研究由报告配方承担。材料随报告存入 `user_reports.body`，没有 `user_documents` 表。
- 迁移编号为 0035（舞台）、0036（`stage_settings`）、0037（`user_reports`）。
- 2026-10-22 起提问后对话层淡出，结果只在舞台上展示：回合进行时是加载骨架，之后是 Scene、文字回答、报告提议（开始 / 不用了）或失败提示。对话层只保留读者的问题和简短提示。读者开始的报告独占舞台，先是进度，完成后是报告本身。
- 2026-10-22 起舞台对所有公司默认开放，不设开关：`/agents/status` 对任何合法代码返回 open，后台舞台页只看花费与对话。`stage_settings` 表保留但不再读取。滥用由三层配额限制。
- 消息协议用 JSON，未用 `@callable`（测试运行器的类型剥离不支持装饰器）。
- 严格工具 schema 不接受 minimum / maximum、长度、pattern、format、default 等关键字，注册表统一剥离；`read_series` 为非严格。
- 主包增加约 1.4 KB gzip，超过 1 KB 目标。

未完成或未验证：

- Turnstile 未接入；身份签发限为每地址每天 10 个。
- Safari、Firefox 的 WebSocket 未验证，只验证了 Chromium。
- 后台舞台页需要管理员密码，未在浏览器验证；对应数据已经由 D1 核对。
- 保留期只有惰性清理与 `purge`，R2 生命周期规则未配置。
- 报告的数字校验只查阿拉伯数字。2026-10-21 的样例报告把引文中的 $288 billion 租赁承诺写成"约千亿级别"，未被拦下；中文数量词的校验另行处理。

## 附录：评审意见处理

采纳（已反映在正文）：R0.0–R0.7、R1.0–R1.7、R2.0–R2.7、R3.0–R3.7、R4.0–R4.7、R5.0–R5.7、R6.0–R6.7、R7.0–R7.7 中除下列条目外的全部。

部分采纳：

- R0.4（完成时不移动焦点）：采纳"不移动 DOM 焦点、输入框不失焦"；保留对话层收成 `mini` 的视觉让位，因为这是产品要求的"把注意力交还舞台"。
- R3.2（DO 回合 ≤ 4 轮、≤ 90 s）：取 ≤ 6 轮、≤ 120 s，白名单按其建议只留本地读取工具。
- R5.2 / R3.0（去轮询的最小改法 settle 步）：本期不碰内部管线，连 settle 步也不做；记为 P3 后的单独 ADR。
- R6.5（后台不展示对话内容）：后台可按对话读取内容用于排查，但只显示 `user_hash`，并在对话层明示保留期。

否决：

- R0.3 与 R7.6 都建议去掉预分类，采纳；但 R7.6 "保留 Haiku 分类作先验"的备选不采纳，等待态只由循环事件决定。
- R4.6 的"对话空闲 30 天后由实例自身 alarm 自删"：alarm 在本仓库规则下有争议，改为 3.5 的惰性清理与后台动作。
- R2.5 第一条"客户端把资源读到 basis 修订"采纳；其"metric-trend 逐块 fetch"的否定一并采纳。
