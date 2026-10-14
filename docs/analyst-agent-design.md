# 方案：要点分析师 Agent（Analyst）——让每条要点成为一份可审计的案卷

**状态：** 提议；P0、P1 于 2026-10-14 实现（见文末"实现状态"） · **日期：** 2026-10-13 · **前置：** [finding-lens-agent](finding-lens-agent.md)（已上线）、[findings-events-design](findings-events-design.md)、[sec-filing-library](sec-filing-library.md)、[pipeline-events](pipeline-events.md)

本方案由一次多 Agent 工作流产出：六个读码 Agent 盘点仓库现有的数据与工具，三个设计 Agent 分别从分析师、系统、产品三个角度独立设计，两个评审 Agent 打分与嫁接，一个对抗评审 Agent 拿真实 D1 数据核对每个假设。下文是综合后的结论，"数据现实"一节全部来自对线上数据的核对，不是推测。

## 一句话

在 findings 写作与 lens 排版之间加一个**独立的分析师任务**（`analyst`，Cloudflare Workflow + 队列任务）：它按**通用触发规则**决定每条要点该追问哪几条线，用现有数据（账本、资本结构、文件库原文、SEC 报告、指引、事件、电话会、同业）做多步 ReAct 调查，产出一份"案卷"（论点 → 机制 → 证据 → 同业 → 反证 → 可打分的观察项），harness 只放行它能验证的内容；页面仍然是 lens 文档，只新增引文、表格、记录三种块。**不用 Agents SDK**，多步推理的持久化用现有 Workflows 的 durable step。

## 确定性从哪里来

读者的"确定性"不来自更长的文字，而来自页面上每一句话都属于三类可审计之一：

1. **可点开的数字**：读时从已发布数据解析（现有原则不变，账本扩大）。
2. **可点开的原文**：财报、电话会、新闻的原话，逐字校验，带出处与日期；数字出现在引文里就是引文，不是本站的数字。
3. **可打分的预测**：每条要点的 watch 带确定性的 `test`（方向 + 对比基准 + 容差），下一份财报落地后由共享运行时打分 pass/fail，并累积成这家公司的"记录"。

深度随案例变化的机制：**触发规则决定追问哪几条线，严重度只封顶预算**。资本开支案例触发"资本强度、资金缺口、承诺与表外、需求转化、指引兑现、同业"六条线；一条利润率要点只触发"利润率/结构转向 + 同业"；一条 Form 4 要点触发事件域的线。没有任何公司或科目专用的分支。

## 用户七问 × 数据现实（ORCL，2026-08-31 期）

| 问题 | 能否回答 | 数据现实（已核对线上 D1） | 方案中的答法 |
|---|---|---|---|
| 1 Capex 更有用的信息 | 部分 | 现金流补充行 `unpaidCapex`、`leaseAssetsObtained`、`interestPaid` 已投影但未做成 ref；ORCL 最新季只有 1 条补充行；D&A、SBC 的 SEC 序列已在 XBRL 里但未映射，账本里 capex/D&A 这类比率从未解析过 | P0 先把这些做成可解析 ref；"投向"靠原文引用（见 7） |
| 2 对比上季 | 能 | 账本已有 qoq；缺的是"上次写的和这次有什么不同" | qoq 行 + P4 的"自上次发布以来的变化"（harness 从上一版发布物的证据算，不是模型写） |
| 3 对比同业 | 目前答不了数字 | 业务链接把 ORCL 云业务与 MSFT、NET、CRWV、NBIS 放在同一类，NVDA 与 ORCL 无共同类别；真正可比的超大规模云厂商 AMZN、GOOGL、META 不在数据名单；各家最新季末 06-30 vs ORCL 08-31，45 天对齐规则下同业行为空 | 同业改为**确定性全局投影**（`peers:v1`，按"报告期之前最近一季、120 天内"对齐，列头显示各自期末）；AMZN/GOOGL/META 是否加入数据名单是一个需要你决定的配置项；未跟踪公司只能以带日期的引文出现 |
| 4 Capex 如何"优化"资产负债表 | 部分 | 分析师真正会查的是：数据中心是经营租赁还是融资租赁、供应商融资/未付 capex、客户预付款（递延收入）作为资金来源、售后回租、合作方代建 | 作为"资金与承诺"线的固定问题；数字来自新 ref（leases、customerAdvances、payables、unpaidCapex），谁拥有数据中心靠原文 |
| 5 表外负债 | 能，但要先修解析器 | 10-Q 的 "Unconditional Obligations" 表（余下 FY2027 $5,449M … 合计 $34,150M）可达；10-K 的债务附注、PP&E、租赁、承诺全部在 Item 15 之下，解析器把它们归为 `exhibits`/boilerplate（85/86 节），find/read/卡片/AI Search 全部跳过；担保、VIE、合作方容量承诺没有提取器 | **P0 先修解析器**（Item 15 财报与附注 → canonical `note`，重新拆分），否则这条线在 10-K 上永远"未披露" |
| 6 表内负债 | 能 | 资产负债表分组（debt、leases、customerAdvances、payables）已投影；到期阶梯只在 10-K 债务附注（当前不可达），10-Q 无债务附注 | 分组做成 ref 画堆叠柱；到期阶梯 P3 做 XBRL schedule 提取（`LongTermDebtMaturities*`），缺失时引用附注表格 |
| 7 投向了哪里 | 只能引用 | ORCL 不披露分部 capex；按地区的长期资产在 10-K（当前不可达）；服务哪些客户/地区只在电话会和新闻里 | 诚实地给引文（财报句子、电话会原话），并在"覆盖"块里由模型写明未披露；不列一个解析为空的 ref |

另两处与"确定性"直接相关的现实：ORCL 指引只有一条 capex 项（FY2026 年度 $50B，无 FY2027、无 FCF/OCF/RPO 项）；电话会文本只有一期（2026-08-31），其余约 95 条在 Alpha Vantage 配额里排队。方案必须在这些缺口上**显式说"没有"**，而不是把缺口藏在更长的文字里。

## 架构

```
map.derived / guidance.published / fundamentals.updated / analysis.published ──▶ findings（现状：写作 → 校验 → lens → 亮点）
                                                                                   │ findings.published
filing.archived(10-K/10-Q) / transcript.stored / peers.published ────────────────▶ analyst（新任务，scope ai，debounce 10 min）
                                                                                   │
   AnalystWorkflow（每条要点一个 ReAct 循环，durable step = 一轮 / 一次工具调用）
   ┌ plan（确定性）→ inquire（工具 + draft/compile）→ review（只删不改）→ dossierToDocument → publish ┐
   └ 发布物：findings 记录上的 dossier 字段 + materials（引文出处）+ analystTrace（仅 Admin）        ┘
                                                                                   │
   页面：/findings 读路由一次查找；dossier 的 findingsFingerprint 与当前 findings 匹配才渲染，否则显示 lens 文档
```

**为什么是独立任务而不是 findings 内的一个阶段**（三份设计中两份如此，评审一致）：运行时长是 findings 的十倍；触发面更宽（新 10-K/10-Q 原文、新电话会、融资类 8-K 要重跑案卷但不该重跑写作）；失败或日预算耗尽不能拖住 findings 与亮点；版本号独立，提示词改动不重跑写作。案卷以 `findingsFingerprint` 绑定当前 findings，不匹配时页面静默退回 lens 文档。

**案卷缓存**：键为 subject 内容哈希（锚定 ref + 视图 + 报告期 + ANALYST_VERSION），而不是 finding id——写作是高推理非确定的，id 与证据集每次重写都会变，按 id 缓存等于没有缓存。

### 流程

1. **plan（无模型）**：对每条通过校验的要点，harness 从账本差值与锚点算出触发的线（见下表）、tier 与预算。light（severity 1 或 kind watch）直接跳过，保留现在的单图 lens。至多 5 条线；"资金缺口""承诺与表外"在现金类要点上总是一起触发，合并为一条"资金与承诺"。
2. **inquire（ReAct，reasoning high，12–16 轮）**：动作 `find_sections`、`read_section`（可带 `previous:true` 读上一份文件同一节做对照）、`facts`（同业业务收入事实）、`report`（SEC 报告的 disclosures 与叙述变化）、`transcript`（关键词定位，带发言人）、`guidance`、`peers`、`draft`、`finish`。P3 再加 `search`/`read_web`。每个观察都是 harness 算好的文字：数字观察只渲染目录行（标签 + 值 + ref id），文本观察只给带编号的逐字材料。
3. **draft 即校验**：`draft` 提交整份案卷，harness 跑 `verifyDossier`（数字 / 引文 / 表格 / 同业 / watch）+ `compileDocument`/`auditDocument`（图表与版面）并回传逐项结论；`finish` 只接受最后一次零错误的草稿。这是 lens agent 已验证的模式，把"写—验—修"折进循环，不再有单独的 repair 调用。
4. **review（1–2 次调用，只删不改）**：独立的第二次判断，专门看"逐字但误导"的引用与过度推断——子串校验看不出意思。
5. **dossierToDocument（确定性）**：案卷各节按固定顺序变成 lens 文档（论点行 = 判断 + 证据表 | 主图；机制行 = 段落 + 图/表；证据行 = 引文；同业行 = 表 + 段落；反证行；观察行 = watch + 记录；来源）。它**必须按构造零错误编译**；lens agent 的低推理轮次只做可选润色，永远不是门槛——线上 `capex-outruns-cash` 已经证明 6 轮低推理清不掉一份复杂文档的警告。
6. **publish**：与 findings 发布物同一条 `sec_cache` 记录；公开读取经契约剥离轨迹。

### 触发规则（通用，不含公司或科目专用逻辑）

| 线 | 触发（harness 从账本算） | 固定追问 | 证据来源 |
|---|---|---|---|
| 资本强度 | 证据含 capex，或 capex/收入、capex/D&A 比率 yoy 绝对值 > 40% 或 capex/D&A > 2× | 买的是什么（PP&E 类别、租赁 vs 自有）；资产增速是否快于其对应收入；缺口如何融资；指引是否兑现 | 新 ref、property/leases/liquidity 原文、电话会定位、指引项 |
| 现金/利润背离 | OCF/净利 < 1× 或 > 1.5×，或 FCF 变号 | 哪些经营项解释背离；结构性还是一次性；递延收入/应收是否粉饰 | OCF/净利 8 季、D&A、SBC、customerAdvances、现金流 MD&A |
| 资金与承诺 | 发债或发股 > 收入 20%，或 debt/equity、cash/debt yoy 变动 > 0.3×；或视图为 balance；或承诺附注 change=changed | 发了什么、何时到期；表内（债务、租赁、预付款、应付）vs 表外（采购承诺、未开始租赁、担保）；利息与税负占 OCF；谁拥有资产 | 资产负债分组 ref、schedule ref、债务/承诺附注原文及上一份的对照、融资类 8-K 附件 |
| 需求转化 | 收入节点 yoy > 25%，或 RPO/收入 > 2×，或判断里点名增长驱动 | 积压是否按管理层说的节奏转化；收入是否跟上为它建的资产；客户集中度 | 节点 yoy、rpoBucket、节点/capex 比率、收入与分部附注、客户集中度原文 |
| 指引兑现 | 证据 ref 有 12 个月内的指引项，或期内有 raised/lowered | 落在区间上/中/下；印前是否已调整；管理层说的变量 | `{guidanceId}` 对比、指引原话、EX-99 |
| 利润率/结构转向 | 毛利/营业/净利率 yoy > 2 pp 或 qoq > 1.5 pp，或分部份额变动 > 3 pp | 哪些费用行相对收入变动；新结构的利润率是否不同；管理层归因原话 | 费用比率行、份额面积、分部附注、MD&A 经营成果段 |
| 同业 | severity 3，或 severity 2 且视图为 cash/balance；且同类别已跟踪同业 ≥ 2 家 | 同一比率在各同业的走势；是公司特有还是行业同向；同业财报对同一机制怎么说 | `peers:v1` 投影、`{peer:{ticker, ref}}`、跨公司文件库检索 |
| 事件/新闻域（替代以上） | subject.domain 为 event（融资/并购/回购类 8-K、Form 4 簇）或 news | 条款原话；事件触及的账本数字如何变化；基准率（此人/此公司之前做过几次） | 事件发布物与 insider 指标、附件原文、规划中的 `{event, field}` ref |

每个域有两条"始终"线：开头（论点所依赖的账本行）与结尾（可打分的 watch）。事件域的始终线按事件定义（附件原文 + 触及的 ref），否则 L1/L9 在事件要点上永远不触发，案卷会被整体扣留。

### 验证规则（harness 执行，页面同一份运行时再执行一次）

- **数字**：标题、段落、表格、注释中的每个数字必须属于所引 ref 的 `evidenceCandidates`（2% 容差），读时由 `resolveRef` 解析。同业数字从 `peers:v1` 投影解析。附注表格的单元格只有在表格单位能解析为数值刻度且单元格不含 `%` 时才可做 `{passageCell}` ref（`table_json` 的单位是自由文本，45 张表里 5 张无单位；未解析刻度的 "5,449" 会以错误量级渲染），否则只能作为引文。
- **引文**：写时 `compactName(quote)` 必须是本轮实际读过的材料的子串，记录 `{passageId, textSha256}`；**读时按 passageId 重新从 D1 读原文**（`libraryPassages`），原文不存在（解析器升级后 id 变化）即撤下——不能用随发布物一起传来的文本自证。电话会同理按 turn 定位。
- **Web**：读路由只能查 D1，R2 快照读不到；web 引文在发布时验证一次，发布物携带 quote、url、hash、retrievedAt，标为发布时验证且不再重验。段落引用 web 材料必须带逐字锚句，且不得含账本之外的数字；web 数字只能出现在引文块里。材料文本先剥离指令式行再给模型；只能读本轮搜索返回的 URL。文件库原文（8-K 附件、新闻稿）同样是不可信输入，同样剥离。
- **同业**：表格 ≥ 2 行才渲染；"行业/板块"均值或中位数措辞需 ≥ 4 家；段落点名的 ticker 必须就是表里的。
- **Watch**：`test` 在写时必须结构可解析；pass/fail 只由共享运行时 `watchVerdict` 算。
- **扣留而非展示**：不支持的数字、找不到的引文、解析不出的表格行、编译失败的图、低于行数门槛的同业块、tier 要求的节为空——整份案卷在 draft 被拒；始终没有干净草稿则保留写作者的判断与单图 lens，绝不发布看起来完整的半份案卷。

### 页面（沿用 lens 文档，三种新块）

- `quote`：引文块，出处行（文件标题、表格类型、申报日、标题路径）+ 链接到新增只读路由 `GET /api/v1/companies/:t/passages/:passageId`（D1 查找，返回该段及前后两段）。web 引文显示发布日与抓取日，视觉上与财报引文区分。
- `table`：行是 ref（或同业 ref），读时解析，文档里不带数字；未解析的同业格留空，不画破折号。
- `record`：这家公司历次 watch 的测试与结果（pass/fail/pending + 解析出的数值），由共享运行时从历史版本算出；第二份发布物出现前不渲染。
- 行标题用 `LensRow.title`（≤60 字符、无数字、模型所写），不加 heading 块。
- "覆盖"：模型写的逐行说明（如"10-K 未披露分部资本开支，已查看 property 附注"），每行只是 AI 文本；操作性状态（预算耗尽、被扣留）只进 Admin 轨迹，不上页面。在解析器与主题修复落地前，"未披露"断言延后到 Admin 轨迹——一条错误的"未披露"比没有更伤信任。
- 前端新增的固定字符串只有已允许的数据标签（ticker、日期、表格类型、一词的 verdict 枚举）；无叙述模板。

## 为什么不用 Cloudflare Agents SDK

三份设计与两位评审一致，Agents SDK 自己的文档也这么说（"长流程、需要自动重试的用 Workflows"）：

- 这个任务是**批处理、队列触发、无客户端会话**：没有 WebSocket、没有每用户状态、没有定时唤醒（alarm 在本仓库规则下就是换了名字的轮询）。Agents SDK 多出来的三样东西——有状态 actor、客户端状态同步、调度——一样都用不到。
- 多步推理需要的持久性**已经有了**：`workers/pipeline/src/index.ts` 的 `durableSteps` 把每一轮模型调用和每次工具调用做成命名 `step.do`（结果 > 512 KiB 溢写 R2，重放跳过已完成步，5xx 步内重试，4xx 转 `NonRetryableError`，`SecModelOutputError` 变成一轮 `{action:"invalid"}`），死信进 `pipeline_dead`，`trackRun/trackSteps` 给 Admin 轨迹。业务脑图与 lens agent 已经这样跑 ReAct。
- 引入 Durable Object 会带来第二套持久化模型与 migrations，且 DO 在一次 2–5 分钟的 DeepSeek 调用期间按墙钟计费（Workflow 步等待 fetch 不计）。
- `runFiber`/`stash` 没有自动重试，lambda 不恢复，只能在 `onFiberRecovered` 里重新推断——对一个 30 步的调查循环，这比 `step.do` 差。

**什么时候该用**：当产品要做"向分析师提问"的交互会话（读者就某条要点追问、流式回答、会话内记忆）时，Agents SDK 的 `AIChatAgent` + WebSocket + 每会话状态正是为此设计的；届时它调用的仍是本方案的工具与验证器，分析本身仍在 Workflow 里跑。

## 前置数据工作（P0，无 Agent 改动）

1. **解析器**：Item 15 的财报与附注 → canonical `note`，对其 ix 文本块跑 `noteTopic`，升 `LIBRARY_PARSER_VERSION` 重新拆分。这是表外/表内两问的硬前提。注意 passage_id 随拆分变化，读路由要容忍引文失效。
2. **账本扩容**：已投影但未做成 ref 的分组与补充行做成 `CapitalMetric`（leases、leaseAssets、productive、receivables、inventory、intangibles、investments、customerAdvances、payables、deferredTax、currentAssets/Liabilities、acquisitions、leasePrincipal、interestPaid、taxesPaid、unpaidCapex、leaseAssetsObtained、depreciation）；映射 SEC 序列（D&A、SBC、长期债务、总负债、股东权益、应收、存货、股数）；新增比率（capex/D&A、利息/OCF、流动比率、租赁/债务）。
3. **同业投影**：确定性、无模型的 `peers` 任务（scope global，订阅 map.derived 与 fundamentals.updated，发布单一全局键 `peers:v1`，约 20 个 ref × 8 季 × 已跟踪公司，带 accession）；按"报告期之前最近一季、120 天内"对齐。按公司分键会因路由按 event.ticker 而过期。
4. **成本账本**：`ai_usage_log` 已在迁移 0018 删除；需要新迁移（run id、stage、model、输入/输出/缓存 token、搜索次数），写入点是 `callWorkerSecModel` 的 `tuning.onMetrics`。在任何第二家 AI 公司之前落地。
5. **Watch 测试**：`FindingWatch.test {expect, against, tolerance}` + `watchVerdict` + 记录装配（从 `AiRunStore.versions`）。
6. **只读路由**：`/passages/:passageId`。
7. **事件细节**：`events.published` 目前不带 detail，无法按类别过滤；要么补 `{classes}`，要么订阅 `filing.discovered` 用现有 8-K item 正则。

## 分期

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 数据解锁 | 上节 1–7；`FINDINGS_VERSION` 升级让现有写作者用上新 ref | ORCL 账本解析出 capex/D&A、SBC/收入、leases、customerAdvances、unpaidCapex、interestPaid 的 yoy/qoq；10-K 债务附注与承诺表可被 `libraryRead` 读到；一条带 test 的 watch 对历史期显示 pass/fail |
| P1 案卷语法与页面 | `quote`/`table`/`record` 块、`{peer}`/`{schedule}`/`{passageCell}` ref、`LensRow.title`、tier 化 `LENS_LIMITS`、读时按 passageId 重验引文、passages 路由 | 一份手写 ORCL 案卷在 1280/1024/720 渲染全部六行，引文可点开原文，两行同业表解析、一行被撤，篡改的引文被撤 |
| P2 Analyst over 自有数据 | `analyst` 任务与 Workflow、plan、ReAct（不含 web）、`verifyDossier`、review、`dossierToDocument`、缓存、轨迹进 Admin、`feature_budget` 日上限（耗尽时睡到次日而非中止） | ORCL capex 要点的案卷回答七问中自有数据能答的部分（qoq、表内分组、承诺引文与 schedule、资金瀑布、capex 指引 verdict），零扣留数字，每条引文可点开；light 要点不变；Admin 可见每轮与成本 |
| P3 Web 证据 | `search`/`read_web`、材料摘录存 D1（可读时重查）、锚句验证、日期标注、指令剥离；schedule 与分部 capex 提取（`CAPITAL_VERSION` 升级） | 案卷里出现一条未跟踪同业的带日期 web 引文（发布者、发布日、抓取日），没有 web 数字被当成解析数字；到期阶梯从 schedule ref 解析 |
| P4 记录与跨期记忆 | `record` 块上页；"自上次发布以来的变化"由 harness 从上一版证据算；公司记忆判断作为上下文 | 下一份 ORCL 财报后，capex watch 显示 pass/fail 与解析值，记录列出它，新案卷在机制行引用上次判断 |
| P5 泛化与扩面 | 事件 subject（`{event, field}` ref）、新闻 subject、`SEC_AI_TICKERS` 扩到数据名单并提高并发、SIC 作同业类别兜底 | MSFT 或 NVDA 一份财报产出案卷且无任何 ORCL/capex 专用代码路径；一条内幕交易案卷渲染附件引文、持股路径图与可打分 watch |

对抗评审建议的收缩（已采纳）：P1–P2 不做 web；电话会引文可选（只有一期）；同业表在对齐规则与数据名单决定前不作为验收；`events.list` 工具推迟到 P5；不建 Admin `peer_sets` 表（后台刚收敛到 BusinessView，覆盖用配置项）；`filing.diff` 推迟；轮数 24 → 12–16。

## 成本与运行时风险

- **墙钟才是真正的成本**：12–16 轮高推理每轮 20–120 秒，加 compose 与 review，Workflow 步超时 60 分钟 × 3 次重试，FINDINGS_WORKFLOW 并发为 1；一个卡住的供应商能占住一家公司数小时，版本号升级要排几天。AI 名单扩面时并发升到 3，`driveWorkflow` 的 5 分钟轮询在长跑时会持续重排队列消息。
- **扣留率**：lens agent 在 `capex-outruns-cash` 上 6 轮无结果；更严的校验、更多轮、拒绝 finish、只删不改的 review 会扣留更多。先在 ORCL 上测 invalid 轮与扣留率，再扩第二家。
- **引文再分发**：财报是公共领域，电话会（Alpha Vantage）与新闻不是；≤600 字符引文块上公开站点有供应商条款与版权暴露，需要你定边界。
- **主题可靠性**：发行人自定义 ix 块（如 `orcl:LeasesAndOtherCommitments…`）和 SEC 规则变化（2021 年后无"合同义务"表）会让按主题的触发静默失效，"未披露"可能是错的——所以 P2 的"未披露"只进 Admin。
- **情景/敏感性**（"若 capex 维持 X，FCF 为 Y"）是读者最想要的确定性，但那是模型算出的数字，当前原则禁止；要做必须新增"算术 ref"（声明式的 ratio/差值由 harness 计算），列为 P4 之后的待决项。
- **可见性窗口**：案卷绑定 findings 指纹，findings 每次重跑（任一归档申报的 map.derived、guidance、analysis 时间戳）后案卷会在整个调查运行期间消失——恰好在新财报落地时。按 subject 哈希缓存能缓解，但 id 稳定性需要写作者配合。

## 同业线（修订，见 [analyst-peers-prompt](analyst-peers-prompt.md)）

同业线的提示词、payload、观察示例单列成文。相对上文的三处修改：harness 先算一张 `divergence` 表（主体与各同业在对齐期的可比比率与离散度，标记主体落在区间外的行），模型从被标记的行开始；经营指标（MW、GPU 数、已签约容量）通过新增的 `kpis` 提取任务（P3，带 passageId 锚句、读时重验）成为 `{kpi:{ticker,key}}` ref，否则只能作引文；新闻只做带日期的引文，优先公司自己的新闻稿。

## 实现状态（2026-10-14，P0 + P1，仅 ORCL 在 AI 名单内）

P0：解析器 `filing-library.v2`（Item 15 下的报表与附注按 Item 8 规则拆分；本地对 ORCL FY2026 10-K 实测 76 节 `note`、8 节 `financial_statements` 可达，部署后 `library` 任务按版本号重拆全部文档）；`CapitalMetric` 扩到 37 项（租赁、预付款、应付、递延税、PP&E、ROU、流动资产/负债、总负债、收购、投资净额、租赁本金、D&A、SBC、现金利息/税、未付 capex、租赁取得），账本新增 7 个比率；SEC 序列注册表 v4 新增 D&A、SBC、总资产/负债、权益、应收、存货、长期债务（下次 sec-report 运行后生效）；`peers` 全局任务发布 `peers:v1`（120 天对齐）；`FindingWatch.test` + `watchVerdict` + 发布时装配 `record`；`ai_usage` 迁移 0023 与每次模型调用的写入，Admin 显示 30 天用量；`GET /api/v1/companies/:t/passages/:id`；`events.published` 带 `classes`。

P1：lens 文档新增 `quote`/`table`/`record` 块与 `LensRow.title`；`{peer}`、`{passageCell}` 引用；发布物携带 `materials`，读路由按 passageId 从 D1 重读原文并随响应下发 `passages` 与 `peers`，页面用 `verifyQuote` 逐字核对、`compileTable` 解析表格（同业表 ≥ 2 家才渲染，列头带各自期末）；`findings/authored/ORCL.ts` 的 capex 要点改为手写案卷（图 | 判断，资金表 | 段落，两条承诺引文 + 采购义务表格单元格，两条引文，同业表，记录，来源），本地在 1440 与 375 宽度核验无横向滚动、引文可点开原文。未做：`{schedule}` 引用（P3 的 XBRL 提取尚无数据）、Admin 的 Lens 轨迹之外的分析师轨迹（P2）。

### P2（2026-10-14 实现）

`analyst` 任务（scope ai，订阅 `findings.published` 与 10-K/10-Q 的 `filing.archived`，去抖 10 分钟）与 `AnalystWorkflow`（`spontra-analyst`，并发 1，`ANALYST_ENABLED`）。流程：`plan.ts` 从账本差值确定性地开线（资本强度、现金/利润背离、资金与承诺、需求转化、指引兑现、利润率/结构、同业；至多 5 条，严重度只定 tier 与预算：深 14 轮 / 标准 9 轮 / 轻 0 轮）→ `agent.ts` ReAct（动作 `find_sections`、`read_section`（含 `previous`）、`peers`（divergence 表 + 各同业可解析 ref）、`compile`、`finish`；读过的段落成为 `m<n>` 材料，引文只能指向它们）→ 每次 `compile` 跑 `verifyLensDocument` + `auditDocument`（引文逐字、表格解析、数字对照证据）→ 只接受零错误 → 一次只删不改的 review → 发布 `dossier:v1:<ticker>`（绑定 findings 指纹；`analystTrace` 同记录）。读路由 `readFindingsResponse` 在指纹匹配时用案卷文档替换要点的 lens 并合并材料。每日模型轮次上限 `ANALYST_DAILY_TURNS`（默认 300，`feature_budget`）。Admin「公司要点」新增「要点分析师」页签：每条要点的 tier、开的线、轮次、警告、审校移除与完整研究过程。未做：按 subject 哈希的案卷缓存（当前绑定 findings 指纹，findings 重写即重研究）。

## 需要你决定的事

1. 是否把 AMZN、GOOGL、META 加入数据名单（否则 ORCL 的同业行在数字上为空，只能引文）。
2. 电话会与新闻引文上公开页面的边界（长度、是否只对财报引文开放链接）。
3. 是否接受"算术 ref"作为原则的扩展，以支持情景句。
4. P2 完成前是否把 Admin 的"未披露/覆盖"保持在后台不上页面（方案默认是）。
