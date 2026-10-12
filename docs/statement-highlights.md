# ADR：报表亮点数字（Statement highlights）

**状态：** 已采纳 · **日期：** 2026-10-12

## 背景

业务地图舞台顶部的数字条（利润、现金流、资产负债表三个视图）原本在 `BusinessMap.tsx` 里写死：利润视图永远是收入/毛利/营业利润/净利润，现金流视图永远是经营现金流/资本开支/筹资/现金变动。数字本身正确，但不告诉读者"这个季度发生了什么"。Capex 翻倍、云业务利润跳涨、自由现金流转负，这些都只能从图里自己找。

目标：解析财报时，由模型对照最近一季与之前 5 个季度同一张表的变化，为每个视图挑出 3 个亮点数字，并给每个数字写一个标题（如 "Capex surges"、"Cloud operating income jumps"）。

约束：

- 页面上的每个数字必须来自已发布数据，模型不得写数字（与 findings 相同的原则，见 `shared/analysis-contract/findings.ts`）。
- 读路由只做查找，模型调用只在 pipeline 内（[SEC data prepared before read](sec-filing-library.md)）。
- 除 SEC 发现外不加 Cron，任务由事件驱动（[pipeline-events](pipeline-events.md)）。

## 决策

**亮点作为 findings Workflow 的一个独立模型阶段生成，随 findings 发布物一起存储；页面在读时解析数值并校验，校验不过的视图回退到原来的固定数字条。**

1. **数据表**（`workers/pipeline/src/findings/ledger.ts` · `buildHighlightTable`）：对每个可解析的引用（利润表科目、业务节点、利润率等比率、现金流与资产负债表科目、SEC fundamentals），给出最新季度及前 5 个季度的已格式化数值，以及最新季度的 YoY/QoQ。每行标注所属视图（`refView`）。模型只看这张表，不做计算。
2. **生成**（`workers/pipeline/src/findings/highlights.ts`）：findings 写完并校验后，再做一次模型调用。输入是数据表加上已通过校验的 findings 标题（作为参考，使亮点和 findings 不互相矛盾）。输出每个视图 3 个 `{ ref, compare, title }`，按显著程度排序。
3. **校验**（`shared/analysis-runtime/highlights.ts` · `verifyHighlights`，pipeline 和页面共用同一函数）：引用必须属于该视图，在该季度可以解析出数值；比较期也必须存在；标题不得含数字；同一视图内引用不得重复。只存储通过校验的数字条目。
4. **存储**：`FindingsPublication.highlights: ReportHighlights[]`，按 `periodEnd` 区分。新的报告发布时，保留之前报告的亮点（最多 8 期），因此每个季度展示的都是该季度财报解析时写下的亮点。
5. **展示**（`BusinessMap.tsx`）：所选季度、所选视图有 ≥2 个通过校验的亮点时，数字条显示亮点：标签是模型标题，大数是解析出的数值，注释是 `科目名 · YoY +32%`（确定性生成）。否则显示原来的固定数字条。选中某个业务时，利润视图仍显示该业务的固定数字条（亮点是公司层面的）。

## 备选方案

### A：新增独立任务与 Workflow（`highlights`）

| 维度 | 评估 |
|---|---|
| 复杂度 | 高：需要新的 Workflow 绑定、`index.ts` 类、注册表行、`AiRunKind`、Admin、读路由、站点 Worker 路由和前端加载 |
| 成本 | 一次模型调用 + 一次独立的输入读取 |
| 隔离性 | 好：findings 失败不影响亮点 |

**优点：** 失败相互隔离，版本相互独立。**缺点：** 要改十几个文件；输入（快照、资本结构、fundamentals）与 findings 完全相同，等于读两遍；亮点与 findings 各写各的，可能互相矛盾。

### B：放进 findings 的同一次模型调用

| 维度 | 评估 |
|---|---|
| 复杂度 | 低 |
| 成本 | 最低：不增加调用 |
| 可靠性 | 差：一次 8 分钟的高推理调用输出变长，格式错误会同时影响两者；无法单独重试 |

### C：findings Workflow 内独立阶段，随 findings 发布（采纳）

| 维度 | 评估 |
|---|---|
| 复杂度 | 中：契约、共享校验、一个 writer 模块、Workflow 一个阶段、前端 |
| 成本 | 每次 findings 运行多一次较小的调用 |
| 一致性 | 好：同一份数据，看得到 findings 标题 |

### D：不用模型，按偏离度（z-score）确定性排序

规则可复现、零成本，但写不出"云业务利润跳涨"这样的标题，也无法判断哪些变化是结构性的、哪些只是季节性的。未采纳。数据表里的 YoY/QoQ 已经为模型提供了同样的信号。

## 权衡

- 选 C 而不是 A：输入相同、触发条件相同（`map.derived` 等事件 → findings 指纹变化），拆成两个任务只增加连接代码，没有带来收益。耦合的处理：findings 没有任何一条通过校验时，亮点照样发布，findings 用之前已发布的版本兜底（上一次运行的结果，没有则用人工撰写的版本），并记下本次指纹，避免同一输入反复重跑。连之前的版本都没有时，发布一份只含亮点、findings 为空的发布物。findings 和亮点都没有通过校验时才不写入。
- 亮点阶段失败（抛错或格式不对）不阻断 findings 发布，只是这一期没有亮点。
- 不做 repair 调用：校验不过的条目直接丢弃，一个视图不足 2 条就回退。之后如果回退率高，再加一次 repair 调用。

## 后果

- 更容易：数字条反映每个季度真正发生的变化；新增可用科目只需加进数据表。
- 更困难：数字条内容不再固定，跨公司对比时位置不统一。
- 需要回看：`FINDINGS_VERSION` 升到 v7，AI 名单内的公司会各重写一次 findings 并生成首期亮点。AI 名单（`SEC_AI_TICKERS`）同时收窄为只有 ORCL；ADSK、NET 已发布的内容继续提供，但不再更新。早于此次发布的季度没有亮点，显示固定数字条，直到下一份财报。

## 实施项

1. [x] 契约：`StatementHighlight`、`ReportHighlights`，`FindingsPublication.highlights`
2. [x] 共享：`refView`、`verifyHighlights`、`highlightChange`
3. [x] Pipeline：`buildHighlightTable`、`writeHighlights`、Workflow 阶段、跨期保留
4. [x] 前端：亮点数字条与回退
5. [ ] 上线后：抽查 MSFT、ORCL、NVDA 最新季度的亮点；统计各视图回退率
