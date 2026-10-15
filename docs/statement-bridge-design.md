# 方案：利润表计算链与列报档案——新公司不再需要改代码

**状态：** 已实现（2026-10-15，见文末"实现状态"） · **日期：** 2026-10-15 · **前置：** [revenue-flow](revenue-flow.md)、[pipeline-events](pipeline-events.md)、[businessview-admin](businessview-admin.md) · **起因：** AMZN 加入数据名单后采集完成却"未就绪"（缺 `pretax`），GOOGL 停在"重述须复核"

## 一句话

利润表的算法不再写在代码里，而是从申报自带的 **calculation linkbase** 读出来：代码只固定四个锚点（收入、经营利润、所得税、净利润），锚点之间的桥由公司自己声明的加总关系走出来，每一段关系都用申报事实算平。走出来的桥存成每家公司一份**列报档案**（数据，带公司级版本）。计算链走不通时由后台 AI 提出结构、由算术决定是否放行；AI 也走不通就降级发布已能核验的部分。**整条流程没有人工确认环节**，后台只用来观察。

## 今天为什么每家公司都要改代码

采集器（`workers/pipeline/src/financial-data/parser.ts`）把三件事写死了：

1. **概念名清单。** `tags` 把每个指标对应到两三个 us-gaap 概念名。`pretax` 只认 `…BeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest` 和 `…IncludingNoncontrollingInterest…`；Amazon 用的是第三个 `IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments`。缺一个名字，整家公司就"未就绪"。
2. **固定公式。** 完整性检查（`shared/analysis-runtime/financial-data/completeness.ts`）要求 `税前 − 所得税 = 净利润` 精确相等（容差 1e-9）。Amazon 在所得税之后还有一行"权益法投资损益（税后）"，2026Q2 为 −1,100 万，所以即便认出了税前，这条公式也会报 `UNBALANCED_STATEMENT`。四种 `incomeModel`（standard / direct_operating / financial / insurance）各一套公式，第五种列报没有位置。
3. **按 CIK 的特例。** `hasDisclosureProfile(cik)` 与文件排序都写死 ORCL 的 CIK（ORCL 走自己的披露解析器、先读 8-K 附件）；收入分部还有一处 ADSK 的产品轴白名单。这些是列报档案的雏形，但以代码形式存在。

此外重述检测靠正文正则：命中"prior period … recast/restated"而不属于"仅重分类以符合当期列报"就终止（`priorPresentationOnly`）。GOOGL 就停在这里。代码注释自己写着"真正的利润表重述要等专门的复核流程"。

结果是：每种新列报 = 改代码 + 升全局解析器版本 + 13 家公司全部重跑。随着名单扩大，这条路只会越来越窄。

## 原则

- **申报即算法。** 公司在 XBRL 里已经声明了自己的加总关系，带权重、带签名。我们读它，不猜它。
- **列报是数据，不是代码。** 一家公司怎么列报存一份档案；档案改了只重跑这一家。全局解析器版本只在解析器代码变化时升。
- **数字永远可复现。** 桥上的每一段都必须用申报事实算平；算不平的拆分不发布。
- **AI 提结构，算术放行。** AI 只决定"哪一行属于哪一段、权重是正是负、哪个概念是锚点"，从不产生数字；它的提议只有在两个独立期间都精确算平时才生效。没有算术可判的地方（重述取哪个基准）用确定性规则，AI 只写说明文字。
- **不等人。** 每一种走不通都有一个自动的终态：放行、降级发布、或保留上一版。后台显示每一步的证据，但流程不等后台。

## 数据现实（已核验）

EDGAR 为每份 XBRL 申报渲染一个 `MetaLinks.json`（仓库已经在用它读分部成员标签，`member-labels.ts`）。其中每个概念带 `calculation` 字段：按 role 列出 `parentTag`、`weight`、`order`，根节点标 `root: true`。以 Amazon 2026-06-30 的 10-Q 为例，利润表 role `ConsolidatedStatementsofOperations` 下：

```
NetIncomeLoss (root)
 ├─ IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments  w=+1
 │   ├─ OperatingIncomeLoss        w=+1
 │   └─ NonoperatingIncomeExpense  w=+1
 ├─ IncomeTaxExpenseBenefit         w=−1
 └─ IncomeLossFromEquityMethodInvestments  w=+1
```

这正是 Amazon 的算法：净利润 = 税前 − 所得税 + 权益法损益（税后）。用 2026Q2 的事实验证：27,461 + 53,396 = 80,857（税前）；80,857 − 18,199 − 11 = 62,647（净利润），与申报一致。`MetaLinks.json` 同时给出每个 role 的 `groupType`（statement / details）和 `shortName`，可以确定哪一个是利润表。

待核验（P0）：2019 年前非 inline XBRL 申报是否也有 `MetaLinks.json`；没有的退回申报目录里的 `*_cal.xml`（同一套 arc，XML 格式）。

## 架构

### 1. 计算链读取

- 新模块 `financial-data/calculation.ts`：按 accession 读 `MetaLinks.json`（和成员标签共用一次请求，已有缓存路径），解析出利润表 role 的全部 arc，存 `sec:calculation:v1:<accession>`：`{ role, root, arcs: [{ parent, child, weight, order }] }`。
- 利润表 role 的选择规则：`groupType === "statement"`，root 为 `NetIncomeLoss` / `ProfitLoss` / `IncomeLossFromContinuingOperations` 之一，`shortName` 命中 operations / income / earnings；多于一个时取 `order` 最小者，并记录候选。
- 老申报或无 `MetaLinks.json`：读 `_cal.xml`（从申报 index 找 `*_cal.xml`）。两者都没有时按第 4 节第一行自动处理（行序重建 → AI 归段 → 两期算平，否则降级）。

### 2. 锚点与桥

代码只固定锚点，不固定中间项：

| 锚点 | 候选概念（按优先级） |
|---|---|
| revenue | `RevenueFromContractWithCustomerExcludingAssessedTax`、`Revenues`、`SalesRevenueNet`、`RevenuesNetOfInterestExpense` |
| operating | `OperatingIncomeLoss`（金融/保险可缺） |
| tax | `IncomeTaxExpenseBenefit` |
| net | `NetIncomeLoss`、`ProfitLoss`、`IncomeLossFromContinuingOperations` |

桥 = 计算树上锚点之间的子树，按阶段切分：

| 阶段 | 从 | 到 | 内容 |
|---|---|---|---|
| direct | revenue | gross（若有 `GrossProfit`）| 营业成本 |
| operating | gross 或 revenue | operating | 经营费用各行（研发、销售、管理、其他） |
| nonoperating | operating | pretax（若有）或 net 的税前兄弟 | 利息、投资损益、其他营业外 |
| tax | — | — | 所得税这一行 |
| afterTax | pretax − tax | net | 税后项：权益法损益、少数股东、终止经营 |

每个阶段是一组 `{ concept, weight, order, label }`，`label` 来自申报自己的 terse label（MetaLinks 已有）。**每个阶段的等式必须用当期事实精确算平**（沿用 1e-9 容差）；算不平就不发布该季度，并把差额写进档案的 `issues`。

今天的 `tags` 清单退化为锚点候选；`incomeModel` 不再决定公式，只决定锚点集合（金融业没有 operating，用 `RevenuesNetOfInterestExpense` 作收入）。

### 3. 列报档案（数据，带公司级版本）

新表 `financial_presentation_profiles`（migration 0025）：

```
cik TEXT PRIMARY KEY
version TEXT          -- 档案内容的 sha256 前 16 位
status TEXT           -- derived | ai_verified | degraded | unresolved
anchors_json TEXT     -- 四个锚点落在哪个概念
stages_json TEXT      -- 五个阶段各自的 concept/weight/order/label
documents_json TEXT   -- 文件顺序规则（如 ORCL 先读 8-K 附件）、是否需要分部成员标签
derived_from TEXT     -- 产生这份档案的 accession
issues_json TEXT      -- 算不平/缺概念的记录，给后台看
verified_at TEXT       -- 最近一次两期算平的时间
updated_at TEXT
```

- 档案由采集器在读最新 10-Q/10-K 时**自动推导**（`derived`）；同一家公司下一份申报的计算链若与档案一致，继续用；不一致（公司改列报）则推导新档案、版本变化。
- 档案版本进入季度的 `comparabilityKey`（替换今天的 `deterministic-sec-v1:<definition>:<tag>`），所以"可比"直接意味着"同一份档案"。
- **只重跑这一家**：档案版本变化时发 `collection.requested`（ticker），走已有的 collect 订阅。全局 `SEC_FLOW_PARSER_VERSION` 只在解析器代码变化时升，这个方案落地时升一次（v12），之后不再因为某家公司的列报而升。
- `hasDisclosureProfile(MSFT)` 与 ORCL 的 8-K 顺序迁入档案的 `documents_json`，删除代码里的 CIK 特例；这两家的档案同样要求两期算平，不因为是迁移数据而免检。

### 4. 走不通时：后台 AI 判定，算术放行（全自动）

每种走不通都按同一个顺序处理：**先跑确定性方法；仍不唯一或不完整，交给 AI 提结构；结构只有在算平时生效；AI 也失败，进入预先定义的降级终态。**

| 走不通的情形 | 先跑的确定性方法 | AI 做什么 | 放行条件 | AI 也失败时的终态 |
|---|---|---|---|---|
| 没有计算链（老申报，无 `MetaLinks.json` 也无 `_cal.xml`） | 用利润表 HTML 的行序、符号（`statementRow` 已有）和已有的小计识别重建树 | 给每一行归阶段、标权重 | 当期与对比期**两个期间**每个阶段都精确算平 | 降级：各阶段只发合计（终点锚点 − 起点锚点，`derived`，带公式），不拆分 |
| 锚点不认识（自定义扩展概念，如 `xyz:NetEarnings`） | 净利润 = 利润表 role 的计算树根；其余锚点按树中位置推定 | 在利润表行中指认锚点 | 锚点代入后整棵桥两期都算平；净利润必须是该 role 的根 | 收入或净利润无法确定：该季度不发布，地图保留上一版，原因 `PRESENTATION_UNRESOLVED` |
| 阶段算不平（链上缺 arc、某行未挂在链上） | 在两个锚点之间、同一 context、尚未用到的利润表事实里穷举子集求和（行数通常 < 15） | 多个子集都能算平时挑一个，并给分量命名 | 两期都算平；每个分量必须是该 role 的报表行，且位于两个锚点之间 | 降级：该阶段只发合计 |
| 正文提示重述（今天的 `RESTATEMENT_REVIEW_REQUIRED`） | 定量复核扩展到桥上全部概念：当期累计 − 当季 = 上一份申报的累计；对比期在新旧两份申报里是否相同 | 只写一句说明（重分类 / 差错更正 / 终止经营 / 分部重组），供页面与事件使用，不碰数字 | 全部相等即"仅列报变化"，直接放行 | 按下面的"最新基准规则"自动处理，不存在等待状态 |

**最新基准规则（重述的确定性处理）。** 分析师的通行做法是以最新申报的列报为准：

1. 最新申报自己给出的对比期数字就是新基准下的历史数字。相邻上一季度优先从最新申报内部推出（第二、三季度：本期累计 − 本季；第四季度：全年 − 前九个月）。
2. 相邻季度无法在新基准下得到时（重述发生在第一季度报告，上一季度来自旧年报），逐行判断：同一对比期在新旧两份申报中数值相同的行仍可比；数值不同的行不显示环比，只显示同比（同比期在最新申报里本来就是新基准）。
3. 旧基准下的历史季度保留，`comparabilityKey` 带旧的档案版本，图表跨基准处断开连线。

GOOGL 今天停住的情形，按这条规则会被自动放行或按行处理，不需要人。

**防止巧合算平。** 子集求和与 AI 提议都可能碰巧凑出一个数。三道约束把概率压到可以忽略：分量必须是该利润表 role 里、位于两个锚点之间的报表行；同一结构必须在当期与对比期两个独立期间都精确算平；结构写入档案后，下一份申报若不再算平，档案自动重新推导，旧结构作废。

**触发与预算（不新增 Cron）。** 档案推导遇到上表任一情形，collect 任务发出 `presentation.unresolved`（ticker、accession、问题清单），新任务 `presentation`（scope data）订阅它：

- 一次运行最多 4 回合 ReAct：模型可以调用 `check` 动作提交结构，harness 用事实逐阶段算平并回报差额（与分析师的 compile 回路同一模式）；算平即结束。
- 模型输入只有该 role 的报表行（概念、标签、行序、符号、两期数值）与问题清单，低推理档即可；用量记入 `ai_usage`（kind `presentation`），日上限走 `feature_budget`（`PRESENTATION_DAILY_CALLS`，默认 60）。
- 放行的结构写入档案，状态 `ai_verified`，发 `presentation.changed` 触发这一家重采；失败写入终态（`degraded` 或 `unresolved`），**同一份申报不重复调用模型**，只有新申报到达或任务版本变化才再试。

**后台只观察。** 白名单详情加"列报"区：档案状态（`derived` / `ai_verified` / `degraded` / `unresolved`）、每个阶段两期的等式与差额、AI 的提议与被拒原因、重述说明。只有一个"重新判定"按钮，作用是再发一次 `presentation.unresolved`；流程里没有任何一步等它。

### 5. 合同变更（增量，不破坏现有读者）

`BusinessFlowQuarter` 新增：

```ts
bridge?: {
  profileVersion: string;
  stages: Array<{
    id: "direct" | "operating" | "nonoperating" | "tax" | "afterTax";
    from: FlowMetric | null; to: FlowMetric;
    components: Array<{ id: string; concept: string; name: string; weight: 1 | -1; amount: FlowAmount }>;
  }>;
}
```

- `figures` 保留，由桥推导（`gross`、`operatingExpenses`、`other`、`pretax` 都可以从阶段求和得到，`basis: "derived"` 带 formula 与 lineage）。今天的 `expenseComponents` / `otherComponents` 成为 `operating` / `nonoperating` 阶段的投影，保留一段时间后删除。
- 完整性检查：有 `bridge` 时逐阶段算平；无 `bridge`（老发布物）走现有公式。`CompleteFlowReason` 新增 `BRIDGE_UNBALANCED`、`PRESENTATION_REVIEW`，替代笼统的 `MISSING_DISCLOSURE`。
- 页面：Sankey 在所得税与净利润之间画 `afterTax` 阶段的分量（和今天画 `otherComponents` 一样的方式），每个节点可点出 lineage。要点与 lens 的 `{metric}` 引用不变；桥上的分量以后可作 `{ component: { stage, id } }` 引用，本方案不做。
- 大数字卡片（`BusinessMap.tsx` 的 `figure("pretax")`）不变，因为 `pretax` 仍由桥推导出来。

### 6. 事件与任务

不新增 Cron。新增两个事件：

- `presentation.unresolved`（ticker、accession、问题清单），发自 collect；订阅者 `presentation`。
- `presentation.changed`（ticker，detail：旧/新版本、状态），发自 collect 与 presentation；订阅者 `collect`（这一家重采）、`map-derive`。

`presentation` 不订阅 `presentation.changed`，collect 对同一份申报的同一组问题只发一次 `presentation.unresolved`，事件图无环，由 `check:pipeline:boundary` 校验。后台的"重新判定"走 `admin` 发件人。

## 分期

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 数据核验（半天） | 对 13 家公司最新 10-Q/10-K 读 `MetaLinks.json`，统计利润表 role 是否唯一、锚点是否齐、桥是否算平；抽两份 2018 年前申报看 `_cal.xml` | 一张表：每家公司 role、锚点、阶段数、是否算平 |
| P1 计算链 + 桥（2 天） | `calculation.ts`、锚点与阶段切分、按阶段算平；`parser.ts` 用桥推导 figures；合同加 `bridge`；完整性检查逐阶段；解析器升 v12 | AMZN 7 个季度发布；现有 12 家结果与今天逐数一致（回归脚本比对 `figures`） |
| P2 列报档案（1 天） | migration 0025、档案推导与版本、`comparabilityKey` 换成档案版本、`presentation.changed`、MSFT/ORCL 特例迁入档案 | 改一家公司的档案只触发该公司重采；代码中不再有 CIK 字面量 |
| P3 自动判定（1.5 天） | 确定性兜底（行序重建、子集求和、扩展的定量复核、最新基准规则）；`presentation` 任务与 `check` 回路；降级终态；预算与用量 | 人为删掉一家公司的计算链后，流程自动走到 `ai_verified` 或 `degraded` 并发布；GOOGL 自动放行或按行处理 |
| P4 后台观察（半天） | 白名单详情的"列报"区与"重新判定"按钮 | 每家公司的档案状态、两期等式、AI 提议与拒绝原因可见 |
| P5 页面（半天） | Sankey 画 `afterTax` 阶段；降级阶段画成单个合计节点；节点 lineage | AMZN 页面显示权益法损益节点，点开能看到 accession 与 contextId |

P1 升一次全局版本，13 家公司重采一次（从归档读，不重新下载）。之后新增公司零代码、零人工。

## 风险与对策

- **一份申报多个利润表 role**（如含分部对账的 details role）：只取 `groupType: statement`，并要求 root 是净利润类概念；多候选记录到档案 `issues`。
- **权重与借贷方向**：MetaLinks 的 `weight` 已经把 `crdr` 折进去，直接按 weight 求和；用事实算平是最终裁判。
- **第四季度推导事实**（年报 − 前九月）：桥按概念逐项相减后再算平，与今天的 `fourthQuarterFacts` 一致。
- **8-K 业绩附件没有 XBRL 计算链**：附件只用于核对数字，桥一律来自 10-Q/10-K；ORCL 的"先读 8-K"顺序只影响取数优先级，不影响桥。
- **性能**：`MetaLinks.json` 每份 1–3 MB，按 accession 缓存一次，和成员标签共用请求。
- **AI 提议的结构碰巧算平**：见第 4 节的三道约束；另外 P3 的回归集包含"故意打乱行归属"的样本，验证 harness 会拒绝。
- **模型预算耗尽**：当日不再调用，问题保持在原终态（降级或保留上一版），第二天由下一次申报或"重新判定"再试；不会因为预算而发布未算平的拆分。
- **金融业/保险**：锚点集合不同（无 operating），阶段退化为 revenue → pretax → net；已有的 JPM、BRK.B 作为 P1 回归样本。

## 对 AMZN 与 GOOGL 的落地

- **AMZN**：P1 完成即发布，计算链直接给出权益法损益，不经过 AI；页面多一个"权益法投资损益（税后）"节点。
- **GOOGL**：P3 完成后自动处理。扩展的定量复核若全部相等直接放行；否则按最新基准规则，相邻季度能在新基准下得到就用新基准，不能就按行取消环比。无需人工。

## 实现状态（2026-10-15）

**P0 核验。** 对 13 家数据公司最新 10-Q/10-K 共 24 份申报读 `MetaLinks.json`：24 份全部找到利润表计算树（CRWV 的报表是"经营与综合亏损表"，根是综合收益，取其中的净利润节点为根）。NBIS 只有 6-K 附件、没有 XBRL，走报表行。

**回归。** 离线 harness 用线上同一套采集代码（`collectComplete` + `readSecDocumentBatch`）对 13 家公司跑 EDGAR 真实申报：

| 结果 | 公司 |
|---|---|
| 与改动前逐数一致（figures、分部、费用、营业外） | ORCL、NVDA、MSFT、AAPL、JPM、BRK.B、ADSK、NET、META、CRWV、NBIS |
| 由不发布变为发布 | AMZN（税前 808.57 亿 − 所得税 181.99 亿 − 权益法 0.11 亿 = 净利润 626.47 亿）、GOOGL |
| 隐藏全部计算链后 | 9 家国内公司全部由报表行得到同样的结构与数字（含 AMZN 的权益法行） |

**与方案的差异。**

- **合同。** 没有新增 `bridge.stages`，而是沿用现有分量数组：新增 `afterTaxComponents`（所得税之后的各行，净利润 = 税前 − 所得税 + Σ）、`presentation`（`calculation` / `statement` / `profile` / `degraded` 与结构键）、`basisChanges`。收入到经营利润一段继续用已有的报表行费用解析（它本来就不按公司写死），计算链只接管经营利润到净利润。
- **顺序。** 计算链 → 报表行（所得税行与净利润行之间的各行，逐一尝试正负号，唯一解才用）→ 已核验的模型结构。报表行与模型结构必须在该申报的每个季度都算平；计算链按季度算平。报表行读取从"到经营利润为止"延长到"到净利润为止"，费用解析只看经营利润以上的行。
- **降级。** 都不平时：有税前利润则所得税之后合成一个派生行"Items after income taxes, net"（净利润 − (税前 − 所得税)，带公式）；没有税前利润则税前按"净利润 + 所得税"派生并注明未拆分。两种都标 `degraded`，并触发模型判定。
- **重述。** 不再读措辞。`restatement.ts` 比较不同申报对同一概念、同一期间的数值，按精度容差判定改动；改动的行在上一季度的可比键上加后缀，当季列入 `basisChanges`，页面对这些行显示 n/a，其余行照常比较；发布门对 `basisChanges` 中的行不要求可比。通用解析器不再产生 `RESTATEMENT_REVIEW_REQUIRED`，`reviewedCurrentPair` 也不再要求措辞"仅重分类"。GOOGL 停住的原因是它写的是 "conform **with** current period presentation"，旧正则只认 "conform **to**"。
- **模型判定与事件图。** `presentation` 任务（scope data）订阅 `presentation.unresolved`；接受的结构写 `financial_presentation_profiles`（migration 0025），再建一个"提取"维护任务重新采集。直接让采集重跑会形成 collect → presentation → collect 的环，事件图校验禁止；维护任务不发 `presentation.unresolved`，所以图仍无环。模型推理档 `low`，每日上限 60 次，每份申报最多 4 次提议。
- **未做。** ORCL 的披露解析器与 ADSK 的产品轴白名单仍按 CIK 写在代码里，它们属于收入侧，不在这条桥上。

**已知的收入侧缺口（不在本方案内）。** GOOGL 三个分部之和比合并收入少 1.06 亿（对冲收益只计入合并收入），现有分部校验正确地不拆分，页面显示"Total company (segment split not yet verified)"。同样的"申报即算法"可以用收入分解表的计算链解决。

## 需要你决定的事

以下都有默认值，实现不等这些答复：

1. `afterTax` 阶段是否画进 Sankey（默认画）。
2. 降级发布是否可接受：某阶段算不平时只显示合计、不拆分（默认可接受；否则该季度整体不发布）。
3. 重述采用"最新基准规则"（默认采用；这是分析师通行做法，旧基准的历史季度保留但跨基准不连线）。
