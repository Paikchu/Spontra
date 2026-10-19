# 方案：三表体检——利润表、资产负债表、现金流量表的联动分析与提示

**状态：** 已上线（2026-10-19）；前端于同日改为"放进三张表里"，不再有单独的三表体检视图（见文末"实现状态"） · **日期：** 2026-10-19 · **前置：** [statement-bridge-design](statement-bridge-design.md)（利润表桥）、[statement-highlights](statement-highlights.md)（亮点数字条）、[findings-events-design](findings-events-design.md)（要点）、[finding-lens-agent](finding-lens-agent.md)（lens 文档）、[analyst-agent-design](analyst-agent-design.md)（触发规则、同业投影）、[peer-similarity-design](peer-similarity-design.md)

## 一句话

在已发布的三张表之上加一层**确定性的"体检"**：固定的指标目录（六个维度、约 30 个指标，每个都是现有 `FindingRef` 能解析的引用）、固定的信号规则（阈值写在契约里，不由模型决定）、一张"利润到现金"的联动图。体检在共享运行时里由一个纯函数算出，页面和 pipeline 用同一份代码：页面直接从已加载的数据画出来，覆盖数据名单里的**全部**公司；pipeline 把同一份结果喂给要点写作者和分析师，让 AI 的叙述建立在同一套数字和同一套触发条件上。页面上出现的每个数字仍然来自已发布数据，每条提示都是"指标 + 规则 + 数值"，不是模型写的句子。

## 现状：三张表已经在，缺的是"看表的方法"

今天页面已经有三张表和两层 AI 内容：

| 已有 | 位置 | 对本方案的意义 |
|---|---|---|
| 利润表桥：收入 → 毛利 → 营业利润 → 税前 → 净利润，按申报自己的计算链算平 | `BusinessFlowQuarter.figures` / `bridge`，Sankey 视图 | 利润表的全部科目可引用（`{metric}`） |
| 资产负债表与现金流量表：分组投影（`AssetGroup`、`LiabilityGroup`、`OperatingGroup` 等），季度现金流由累计表推出，RPO、债务到期阶梯 | `capital-structure.v1`，资金池视图 | 资产负债表 17 个时点量、现金流 18 个流量可引用（`{capital}`） |
| SEC/Yahoo 基本面序列：EPS、D&A、SBC、股数、市值、EV、P/E、EV/EBITDA 等 | `fundamentals-api.v1` | 每股与估值指标可引用（`{fundamental}`） |
| 要点账本里的 23 个比率（毛利率、OCF/净利、capex/D&A、流动比率……） | `findings/ledger.ts` `RATIOS` | 这是体检指标目录的雏形，但只给模型看，页面看不到 |
| 亮点数字条：模型每期为三个视图各挑 3 个数字 | `highlights.ts` | 告诉读者"这期什么变了"，不告诉读者"这家公司健康吗" |
| 要点、案卷、lens 文档、watch 打分、同业表 | findings / analyst / lens | 叙述层；只覆盖 AI 名单内的公司 |

**数据现实（2026-10-19 线上 D1）。** `sec:disclosure-audit:v1:*` 里 10-Q/10-K 的资本投影：

| 公司 | 资产负债表 | 现金流 | RPO | 到期阶梯 | 备注 |
|---|---|---|---|---|---|
| AAPL、ADSK、AMZN、GOOGL、META、MSFT、NET、NVDA、ORCL | 13/13 | 13/13 | 部分 | 部分 | 完整 |
| CRWV | 6/6 | 6/6 | 6/6 | 6/6 | 完整，仅 6 期 |
| JPM | 10-Q 10/10，10-K 0/3 | 同左 | 无 | 10-K 有 | 银行列报；年报资产负债表未投影 |
| BRK.B | 10-Q 5/10，10-K 2/3 | 13/13 | 无 | 10-K 有 | 保险列报；一半季度的资产负债表未算平 |

要点只有 5 家（ADSK、AMZN、NBIS、NET、ORCL），亮点只有 3 家。也就是说：**13 家公司的三张表都在，但只有不到一半有任何"看法"**，其余公司读者只能自己看图。体检层先把"看法"里确定性的那部分（比率、趋势、阈值）做给所有公司。

## 原则

- **页面不写数字，也不写句子。** 指标值由 `resolveRef` 解析；提示是 `指标 · 规则 · 值`，规则用公式表达（`经营现金流 ÷ 净利润 < 1×，连续 2 季`），不是"利润没有变成现金"这样的叙述。解释性的话只能来自 AI（要点、案卷），或者是经 pipeline 生成并存储的术语解释（见"开放问题"）。
- **一套阈值，三处使用。** 页面提示、要点写作者的触发、分析师 `plan` 的追问线，读同一份 `STATEMENT_RULES`。今天分析师方案里的触发表（capex/D&A > 2×、OCF/净利 < 1× 等）迁进来，不再各写一份。
- **按列报选指标，缺的说缺。** 银行没有毛利率和资本开支，保险没有营业利润；`incomeModel` 决定每个维度启用哪些指标；解析不到的指标不显示 0，也不显示破折号占位，而是不出现在板上并在"覆盖"里计数。
- **不做综合评分。** 一个 0–100 的分数会把"流动比率 1.1"和"capex 是 D&A 的 3 倍"折成一个没有依据的数字；体检只给每个维度的指标与命中规则数。
- **不加 Cron、不加表、不加任务。** 体检是纯函数，输入是页面已加载的资源；pipeline 在已有的 findings/analyst 流程里调用它。

## 分析框架

六个维度对应分析师读三张表的顺序（成长 → 盈利 → 盈利质量 → 资本效率 → 财务安全 → 估值）。预测未来三表（分析师框架第 5 步）不在本方案内；它属于预期差方案（2026-10-14 的设计，尚未实现，本分支上没有该文档）。

### 指标目录 `STATEMENT_METRICS`

每个指标是 `{ id, dimension, ref, form, span, better, models }`：`ref` 是现有 `FindingRef`（或下文新增的 `derived` 引用），`form` 是 percent / multiple / money / per_share，`span` 是默认口径（季度或 TTM），`better` 是方向（high / low / none），`models` 是启用的 `incomeModel`。

| 维度 | 指标 | 引用（分子 ÷ 分母） | 默认口径 | 方向 | 列报 |
|---|---|---|---|---|---|
| 成长 | 营收同比 | `{metric: revenue}` yoy | 季度 | high | 全部 |
| | 分部营收同比 | `{nodeId}` yoy（前 4 个一级分部） | 季度 | high | 全部 |
| | 营业利润同比 vs 营收同比（经营杠杆） | `{metric: operating}` yoy − `{metric: revenue}` yoy | 季度 | high | standard、direct |
| | EPS 同比 | `{fundamental: diluted_eps}` yoy | 季度 | high | 全部 |
| | RPO ÷ 营收 | `{capital: rpo}` ÷ `{metric: revenue}`(TTM) | 时点 | none | 有 RPO 者 |
| 盈利 | 毛利率 | gross ÷ revenue | 季度 | high | standard |
| | 营业利润率 | operating ÷ revenue | 季度 | high | standard、direct |
| | 净利率 | net ÷ revenue | 季度 | high | 全部 |
| | 研发 / 销售 / 管理费用率 | research、sales、administration ÷ revenue | 季度 | none | standard |
| | 有效税率 | tax ÷ pretax | 季度 | none | 全部 |
| 盈利质量 | 经营现金流 ÷ 净利润 | `{capital: operatingCashFlow}` ÷ `{metric: net}` | TTM | high | 全部 |
| | 应计项 = (净利润 − 经营现金流) ÷ 总资产 | `derived: accruals` | TTM | low | 全部 |
| | 应收账款增速 − 营收增速 | `{capital: receivables}` yoy − revenue yoy | 季度 | low | standard、direct |
| | 存货增速 − 营收增速 | `{capital: inventory}` yoy − revenue yoy | 季度 | low | 有存货者 |
| | 股权激励 ÷ 营收 | `{capital: stockCompensation}` ÷ revenue | TTM | low | 全部 |
| | 营运资本变动 ÷ 经营现金流 | `derived: workingCapitalChange` ÷ OCF | TTM | none | 全部 |
| 资本效率 | ROE | net(TTM) ÷ `derived: averageEquity` | TTM | high | 全部 |
| | ROIC | `derived: nopat` ÷ `derived: averageInvestedCapital` | TTM | high | standard、direct |
| | 资产周转率 | revenue(TTM) ÷ `derived: averageAssets` | TTM | high | standard、direct |
| | 资本开支 ÷ 折旧摊销 | capex ÷ depreciation | TTM | none | standard、direct |
| | 资本开支 ÷ 营收 | capex ÷ revenue | TTM | none | standard、direct |
| | 固定资产 ÷ 营收（资产形成） | productive ÷ revenue(TTM) | 时点 | none | standard、direct |
| | 增量回报 = Δ营业利润(TTM) ÷ Δ投入资本 | `derived: incrementalReturn` | TTM | high | standard、direct |
| 财务安全 | 净债务 ÷ EBITDA | `derived: netDebt` ÷ `derived: ebitda` | TTM | low | standard、direct |
| | 现金 ÷ 有息债务 | cash ÷ debt | 时点 | high | 全部 |
| | 流动比率 | currentAssets ÷ currentLiabilities | 时点 | high | 有流动项者 |
| | 利息 ÷ 经营现金流 | interestPaid ÷ operatingCashFlow | TTM | low | 全部 |
| | 自由现金流 | operatingCashFlow − capex | 季度 + TTM | high | standard、direct |
| | 自由现金流率 | freeCashFlow ÷ revenue | TTM | high | standard、direct |
| | 自给率 | operatingCashFlow ÷ capex | TTM | high | standard、direct |
| | 外部融资依赖 = 净融资流入 ÷ 资本开支 | (debtIssued − debtRepaid + equityIssued) ÷ capex | TTM | low | standard、direct |
| | 12 个月到期债务 ÷ (现金 + FCF TTM) | `{schedule: debtMaturities, bucket 0}` ÷ (cash + FCF) | 时点 | low | 有阶梯者 |
| | 现金跑道（月） | cash ÷ (−FCF ÷ 12)，仅 FCF < 0 时 | 时点 | high | 全部 |
| 估值 | P/E、EV/EBITDA、EV/营收、P/S、P/B | `{fundamental: pe_ratio}` 等 | 当前 | none | 全部 |

银行（`financial`）与保险（`insurance`）另有一小组：净利率、有效税率、ROE、ROA（net ÷ averageAssets）、现金 ÷ 债务、EPS 同比、估值；其余指标在这两种列报下不启用。NIM、CET1、综合成本率这类行业指标需要专门的 XBRL 概念，不在本方案内。

### 新增引用 `derived`

`FindingBaseRef` 增加一种：

```ts
| { derived: DerivedMetric }
type DerivedMetric = "ebitda" | "netDebt" | "investedCapital" | "nopat" | "accruals" | "nonCashCharges" | "workingCapitalChange"
  | "averageEquity" | "averageAssets" | "averageInvestedCapital" | "incrementalReturn" | "interestExpense"
  | "netExternalFunding" | "cashRunwayMonths" | "debtDueCoverage";
```

每个在共享运行时 `resolveRef` 里按固定公式解析，返回值带 `formula` 与参与计算的引用（`lineage`），页面点开可以看到算式：

| derived | 公式 | 来源 |
|---|---|---|
| ebitda | operating + depreciation | 桥 + 现金流非现金行 |
| netDebt | debt + leases − cash | 资产负债表分组 |
| investedCapital | debt + leases + equity − cash | 同上 |
| nopat | operating × (1 − tax ÷ pretax)，税率夹在 0–35% | 桥 |
| averageX | (X 当期 + X 四季前) ÷ 2 | 时点量 |
| accruals | (net − operatingCashFlow) ÷ averageAssets | 桥 + 现金流 |
| nonCashCharges / workingCapitalChange | 经营段 `nonCash` / `workingCapital` 组之和 | `OperatingGroup` |
| incrementalReturn | (operating TTM − operating TTM 四季前) ÷ (investedCapital − investedCapital 四季前) | 上述 |
| interestExpense | 利润表 `otherComponents` 中名称含 interest 且不是利息收入的行，取为正的费用（发布物里没有分量的概念名，只能按名称） | 桥 |
| netExternalFunding | debtIssued − debtRepaid + equityIssued | 现金流筹资段 |
| cashRunwayMonths | cash ÷ (−FCF 近四季 ÷ 12)，仅 FCF < 0 时 | 资产负债表 + 现金流 |
| debtDueCoverage | (cash + FCF 近四季) ÷ 12 个月内到期债务 | 资产负债表 + 现金流 + 到期阶梯 |

这些引用对要点写作者、lens agent、分析师同样可用：账本多出这些行，模型可以引用，校验器同样能复算。

### 信号规则 `STATEMENT_RULES`

每条规则 `{ id, dimension, metric, test, persist, level, anchors }`：`test` 是对指标值或其变化的比较，`persist` 是需要连续命中的季度数（抑制单季噪声），`level` 是 `alert`（警示）/ `watch`（留意）/ `note`（提示，正向信号也要提示，否则板子只会报忧），`anchors` 是命中时在三个视图上点亮的节点（沿用要点的 `anchors` 结构）。

| id | 规则 | 持续 | 级别 |
|---|---|---|---|
| revenue-decline | 营收同比 < 0 | 2 季 | watch |
| growth-decelerating | 营收同比连续下降且本季 < 上年同季同比 − 10 pp | 3 季 | watch |
| operating-leverage | 营业利润同比 > 营收同比 + 15 pp 且营收同比 > 0 | 2 季 | note |
| margin-compression | 毛利率或营业利润率 yoy < −2 pp | 2 季 | watch |
| margin-expansion | 营业利润率 yoy > +2 pp | 2 季 | note |
| cash-below-profit | OCF ÷ 净利润 (TTM) < 0.8 | 1 | alert |
| cash-above-profit | OCF ÷ 净利润 (TTM) > 1.5 | 1 | note |
| receivables-outrun | 应收增速 − 营收增速 > 15 pp | 2 季 | watch |
| inventory-outrun | 存货增速 − 营收增速 > 15 pp | 2 季 | watch |
| sbc-heavy | SBC ÷ 营收 (TTM) > 15% | 1 | watch |
| capex-cycle | capex ÷ D&A (TTM) > 2× | 1 | watch |
| capex-unmatched | capex ÷ D&A > 2× 且固定资产 ÷ 营收 yoy 上升、营收同比未上升 | 2 季 | alert |
| returns-below-cost | ROIC (TTM) < 8% 且 capex ÷ D&A > 1.5× | 1 | alert |
| returns-strong | ROIC (TTM) > 20% | 1 | note |
| fcf-negative | FCF (TTM) < 0 | 1 | watch |
| fcf-turned | FCF 季度符号翻转（相对四季前） | 1 | note（转正）/ watch（转负） |
| external-funding | 外部融资依赖 > 50% 且 FCF < 0 | 1 | alert |
| leverage-high | 净债务 ÷ EBITDA > 3× | 1 | alert |
| leverage-rising | 净债务 ÷ EBITDA yoy > +1× | 1 | watch |
| liquidity-thin | 流动比率 < 1.0 | 1 | watch |
| maturity-wall | 12 个月到期债务 > 现金 + FCF (TTM) | 1 | alert |
| runway-short | 现金跑道 < 18 个月 | 1 | alert |
| interest-burden | 利息 ÷ OCF (TTM) > 20% | 1 | watch |

阈值是起点，不是定论；它们写在契约常量里，改一次全站同步。规则不含任何公司名或行业名；按列报不启用的指标，其规则自然不命中。ROIC 的 8% 是一个代替 WACC 的常数，页面在规则文本里直接显示这个常数（"ROIC < 8%"），不声称它是该公司的资本成本。

### 三表联动图

分析师真正做的事是把一项活动在三张表上的痕迹连起来。体检提供两条确定性的链：

**利润到现金（每季 / TTM 瀑布）**
净利润 → +非现金项（D&A、SBC 等，`nonCashCharges`）→ ±营运资本变动 → 经营现金流 → −资本开支 → 自由现金流 → ±净融资（发债/还债/发股/回购/分红）→ ±其他投资与汇率 → 现金变动，两端标出期初、期末现金（资产负债表时点）。每一段都是现金流量表的分组之和，所以瀑布一定合拢；合不拢的季度（经营段 `lines` 为 null）只画合计。

**资本链路（8 季折线，指数化）**
资本开支 → 固定资产（`productive`）→ 营收 → 经营现金流，四条线以 8 季前为 100。读者一眼看到"钱先花出去、资产先涨、收入和现金有没有跟上"。配 capex ÷ D&A 与增量回报两个数。这正是分析 CRWV、NBIS、ORCL 这类公司时最该看的链路。

## 架构

```
shared/analysis-contract/statement-analysis.ts     指标目录、规则、derived 枚举、输出类型（statement-analysis.v1）
shared/analysis-runtime/statement-analysis.ts      assessStatements(data: FindingData, periodEnd, locale) → StatementAssessment
shared/analysis-runtime/findings.ts                resolveRef 增加 derived 分支；refLabel 增加 derived 标签
        │                                   │
        ▼                                   ▼
apps/business-site                    workers/pipeline
  BusinessMap：第四个视图"三表"           findings/ledger.ts：账本加入 derived 行与命中规则（给写作者与亮点）
  rail："关注"区（命中规则列表）           analyst/plan.ts：追问线改为从命中规则推导
  LensPanel：规则聚焦的确定性 lens 文档     （后续）proactive-discovery：规则命中作为信号源
```

**计算位置：页面。** 体检的输入（flow、capital、fundamentals、peers）页面本来就全部加载了（`live-company.ts`），`verifyFindings` 已经在浏览器里解析几十个引用；再算 30 个指标 × 9 季是毫秒级。好处：不需要新的发布物、读路由、revision 资源，也没有"pipeline 版本与页面版本不一致"的问题——数据一更新，体检随之更新（live updates 已按资源推送）。pipeline 用同一函数，所以模型看到的命中规则就是页面显示的命中规则。

**版本。** `STATEMENT_ANALYSIS_VERSION` 进入 findings 指纹（规则变了要点可以重写），不进入任何数据库。

**输出类型。**

```ts
type StatementAssessment = {
  version: typeof STATEMENT_ANALYSIS_VERSION;
  periodEnd: string;
  model: BusinessFlowQuarter["incomeModel"];
  dimensions: Array<{ id: Dimension; metrics: AssessedMetric[]; flags: Flag[]; covered: number; total: number }>;
  flags: Flag[];                                  // 全部命中，alert → watch → note，同级按偏离阈值的幅度
  bridge: CashBridge | null;                      // 利润到现金瀑布（季度与 TTM 两份）
  chain: CapitalChain | null;                     // 资本链路四条指数化序列
};
type AssessedMetric = { id: string; ref: FindingRef; label: string; form: Form; span: FindingSpan;
  series: Array<{ periodEnd: string; value: number }>;    // 最多 9 季，供迷你图
  current: ResolvedValue; yoy: number | null; qoq: number | null; better: "high" | "low" | "none";
  peers?: { rank: number; of: number; basis: PeerBasis } };
type Flag = { ruleId: string; level: "alert" | "watch" | "note"; metricId: string; value: ResolvedValue;
  threshold: string;                              // 规则的公式文本，如 "< 0.8×"，由契约给出
  since: string;                                  // 首次连续命中的季度
  anchors: AnalysisFinding["anchors"];            // 复用要点的锚点，三个视图点亮
  evidence: FindingEvidence[] };                  // 复用要点证据结构，lens 文档直接可用
```

**与 AI 层的关系。**

1. 账本（`buildLedger`）增加 derived 行和一个"命中规则"段落（规则 id、指标、值、持续季数）。写作者的提示词要求：要点优先解释命中的 alert，可以反驳（"规则命中但原因是一次性……"），反驳也是要点。
2. 分析师 `plan` 的触发表改为读 `assessment.flags`：资本强度线 ← capex-cycle / capex-unmatched / returns-below-cost；现金/利润背离 ← cash-below-profit / cash-above-profit；资金与承诺 ← external-funding / leverage-* / maturity-wall；需求转化 ← RPO 指标与分部增速；利润率转向 ← margin-*。分析师方案里的阈值表随之删除。
3. 亮点写作者看到命中规则后，更可能把相关科目选成亮点；不强制。
4. 同业：`peers:v1` 已有约 20 个 ref × 8 季，derived 指标中能由 `PEER_FIGURES` 组合的（OCF/净利、capex/D&A、现金/债务、净利率）给出排名；`PeerBasis`（整体可比 / 仅某分部可比）按同行相似度方案的口径，口径不允许的不排。

## 前端

### 布局

舞台的视图切换从三个变成四个：**利润 · 现金流 · 资产负债表 · 三表**。三表视图是体检的家；另外三个视图只多出"点亮"。

```
┌ rail ───────────────────┬ stage ──────────────────────────────────────────────────────────┐
│ ORCL · 2026.08 财报      │ 2026.08 · 利润 ○ 现金流 ○ 资产负债表 ○ 三表 ●        同比 | 环比  │
│                          │ ┌ 成长 ─┐┌ 盈利 ─┐┌ 盈利质量 ┐┌ 资本效率 ┐┌ 财务安全 ┐┌ 估值 ┐   │
│ 亮点（模型挑的 3 个数）   │ │ 1 ●  ││  —   ││  1 ▲    ││  2 ▲▲   ││  1 ▲     ││  —   │   │
│                          │ └──────┘└──────┘└─────────┘└─────────┘└──────────┘└──────┘   │
│ 关注                     │ ┌ 利润到现金（TTM）────────────────┐┌ 资本链路（8 季，指数）──────┐ │
│ ▲ 净债务÷EBITDA 3.4×     │ │ 净利 ▇ +D&A ▇ ±WC ▇ OCF ▇ −capex ▇││   capex ╱╱╱               │ │
│ ▲ ROIC 6.1% · capex/D&A  │ │  FCF ▇ +发债 ▇ −回购 ▇ … Δ现金 ▇ ││   固定资产 ╱╱              │ │
│ ▲ 12 个月到期 > 现金+FCF │ │ 期初现金 ·····················期末││   营收 ╱   OCF —           │ │
│ ● 外部融资依赖 180%      │ └──────────────────────────────────┘└───────────────────────────┘ │
│ ○ 营业杠杆 +22 pp        │ ┌ 指标板 ─────────────────────────────────────────────────────┐ │
│                          │ │ 成长  营收同比 ▁▂▃▅▆ +12%   分部…   RPO÷营收 ▃▄▅▆▇ 5.8×     │ │
│ 要点（AI）               │ │ 盈利质量  OCF÷净利 ▆▅▄▃▂ 0.9× ▲  应收−营收 ▂▂▃▅▆ +18pp ▲  │ │
│ 3 ……                     │ │ 资本效率  capex÷D&A ▂▃▅▇█ 3.1× ▲  ROIC ▆▅▄▃▂ 6.1% ▲  …     │ │
│ 2 ……                     │ │ 财务安全  净债务÷EBITDA ▂▃▄▆█ 3.4× ▲  流动比率 ▄▄▃▃▃ 0.8 ● │ │
│                          │ └─────────────────────────────────────────────────────────────┘ │
│ 事件 / 往期               │ 来源：10-K 0001341439-26-… · 10-Q … · Yahoo（估值）    时间轴 ━━●━━ │
└──────────────────────────┴──────────────────────────────────────────────────────────────────┘
```

- **维度条**（顶部，替代该视图的亮点数字条）：六个维度各一格，显示命中数与最高级别的标记；点一格把指标板滚到该维度并把它的命中项在 rail 里展开。
- **联动图**（中部）：左瀑布、右链路；银行与保险只画瀑布（没有 capex 链路）。窄屏上下堆叠。
- **指标板**（下部）：按维度分组的小倍数图。每格 = 指标名 · 9 季迷你图（柱或线按 form）· 当前值 · 同比/环比 · 规则标记。有同业排名的格子在值旁显示 `3/6`。未启用或解析不到的指标不出现，维度标题显示"覆盖 7/9"。
- **rail 的"关注"区**：在亮点与要点之间，列出全部命中，alert 在前；行 = 级别标记 + 指标名 + 规则文本 + 当前值。折叠时显示前 3 条（与要点一致）。没有命中时该区显示一行"无命中规则 · 覆盖 24/31"。

### 提示的"鲜明"从哪里来

读者不会读完整板，所以提示要有且只有一个入口和一种视觉语言：

1. **级别用要点已有的颜色。** alert 用 `risk` 色，watch 用 `watch` 色，note 用 `strength` 色；标记形状与要点的 `finding-mark` 相同，读者学一次。
2. **三个表视图上点亮，而不是贴标签。** 切到利润视图时，命中规则的 `anchors` 以现有的要点点亮机制（`anchorNodeNames` / `anchorPoolKeys`）描出 Sankey 节点或资金池色带的轮廓，节点旁出现一个级别标记；悬停显示规则与值。同时最多点亮 3 个（按级别取前三），避免满屏标记。
3. **数字条也带标记。** 固定数字条与亮点数字条的四个数字，若其科目命中规则，数字下方画一条级别色的短线；点它等于点 rail 里对应的关注项。
4. **逐条浏览**（要点已有的 story 模式）扩展为"关注 → 要点"：先按级别走命中规则，再走 AI 要点。rail 上的播放键不变。
5. **URL 可分享**：`?flag=leverage-high` 与 `?finding=` 同级，打开即聚焦。

### 聚焦一条关注项

点一条关注项，舞台交给它，复用 lens 文档与 `LensPanel`，文档由确定性函数 `documentFromFlag(flag, assessment)` 生成（类似现有 `documentFromEvidence`）：

- 第一行：该指标 9 季趋势图，规则阈值画成 `rule` 标记（lens grammar 已有 `rule` mark），命中区间用 `band` 着色 | 右侧"figures"块：指标、分子、分母的当前值与同比。
- 第二行：分子与分母的 8 季柱（例如 OCF 与净利润并排），让读者看到是分子掉了还是分母涨了 | 同业表（有口径时）。
- 第三行：相关的 AI 要点（若有要点的证据引用了同一指标，列出标题，点击切到要点）；来源。

没有模型参与，所以每家公司、每条规则立即可用。有案卷的公司，案卷里引用了同一指标的要点自然链接过来。

### 首页

每家公司的卡片在要点标题下多一行：`▲ 2 · ● 1 · ○ 1`（各级别命中数）。首页的"最新财报"列表因此可以按 alert 数排序。这是 P3。

### 文案与 i18n

- 指标名、维度名、级别名、规则文本是数据标签，走 `messages`/`labels`，中文用 `GLOSSARY_ZH` 的固定词（新增：应计项、投入资本、净债务、自给率、现金跑道、增量回报、经营杠杆）。
- 规则文本只含公式与数字（`< 0.8×，连续 2 季`），没有主语、没有判断词。
- 前端不新增任何解释性句子（仓库规则：界面没有人声模板文案，AI 生成内容除外）。读者看不懂"应计项"怎么办，见开放问题 1。

### 无障碍与窄屏

迷你图用 `role="img"` + 由 `describe` 风格生成的 aria-label（"OCF ÷ 净利润，9 季，1.3× 到 0.9×，命中 < 0.8×"）；瀑布与链路沿用 lens frame 的 SVG 渲染与主题 token。窄屏（≤ 720）：维度条横向滚动，联动图上下堆叠，指标板单列。

## 契约变更（增量）

- `FindingBaseRef` 新增 `{ derived }`；zod schema、`refView`（derived 归属：ebitda/nopat/interestExpense → profit，accruals/nonCash/workingCapital → cash，其余 → balance）、`ratioForm`、`higherIsBetter`、`refLabel` 各加一个分支。
- `AnalysisFinding.anchors` 不变；`Flag` 复用它。
- `LensDocument` 不变；`documentFromFlag` 产出合法文档，经 `verifyLensDocument` 同样校验。
- `peers.v1` 的 `PEER_FIGURES` 加 `receivables`、`currentAssets`、`currentLiabilities`（都已是 `CapitalMetric`；`depreciation`、`leases` 已在），否则应收增速与流动比率无法排名。
- 同业投影今天随 findings 响应一起下发（`FindingsResponse.peers`），没有要点的公司拿不到它。排名要对全部公司可用，`/capital` 或一个独立的 `/peers` 读路由要带上投影；这是 P2 的一项。

## 备选方案

**A：pipeline 任务发布 `statement-analysis:v1:<ticker>`，页面只读。** 多一个任务、一个读路由、一个 revision 资源、一次迁移；收益是"页面不算"。但页面已经在算几十个引用，而且亮点、要点校验都在页面做；发布物反而引入版本错位（capital 更新了、体检还是旧的）。不采纳。

**B：由模型为每家公司写"健康度"段落。** 覆盖面受 AI 名单限制（今天 5 家），且与要点重复。叙述留给要点；体检只做确定性的部分。不采纳。

**C：雷达图 / 综合评分。** 六个维度折成一个形状，看起来专业，但每个轴的刻度没有依据，银行与软件公司的雷达不可比。不采纳；维度条只显示命中数。

**D：规则由模型按公司"自适应"。** 阈值会漂移，页面上同一规则在不同公司含义不同，无法审计。不采纳；行业差异用 `incomeModel` 启用/停用指标解决，阈值全局一致。

## 分期

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 引用与目录 | `derived` 引用及解析、`refLabel`/`refView`/zod；`STATEMENT_METRICS`、`STATEMENT_RULES`、`assessStatements`；单元测试用 ORCL、JPM、BRK.B 三种列报的固定数据 | ORCL 2026-08 解析出全部 standard 指标；JPM 只出金融组；BRK.B 资产负债表缺失的季度指标不出现且 `covered` 正确；每条规则至少一个命中与一个不命中用例 |
| P1 三表视图 | 第四视图：维度条、瀑布、链路、指标板；rail"关注"区；聚焦文档 `documentFromFlag`；story 扩展；`?flag=` | 13 家公司都能打开三表视图；瀑布每季合拢；聚焦任一关注项的 lens 文档通过 `verifyLensDocument` 零警告；窄屏可用 |
| P2 点亮与 AI 接入 | 三个视图的锚点点亮、数字条标记；账本加入 derived 行与命中规则；分析师 `plan` 改读 flags 并删除自有阈值；`PEER_FIGURES` 扩展、同业投影对无要点公司可读、同业排名 | 要点写作者对 ORCL 的下一次运行引用了 derived 行；分析师触发线与页面命中一致；同业排名至少在 OCF/净利、capex/D&A 上对云服务组可用 |
| P3 首页与发现 | 首页命中数；规则命中作为 proactive-discovery 的信号源 | 首页按 alert 数排序；发现管线能订阅"新季度首次命中 alert" |

每阶段都走现有发布流程（P1 起涉及地图构建，P2 起同时涉及 Pipeline 构建）。

## 开放问题

1. **术语解释放哪里。** 读者需要知道"应计项""ROIC"是什么。前端不写句子的规则下，可行的做法是：pipeline 用翻译/解释流程为每个指标生成一段中英解释，存为 `i18n_strings` 风格的 AI 内容，页面以"AI 解释"标出来展示。需要你决定是否接受这个例外。
2. **ROIC 的资本成本常数。** 8% 是行业无关的粗值；可以改为按 `incomeModel` 或大标签（同行相似度的第一层）各设一个常数。先用一个。
3. **TTM 的口径。** 四季相加要求四个季度在同一列报档案下可比（`comparabilityKey`）；跨重述的 TTM 不计算，指标板那格留空并计入"未覆盖"。这会让 GOOGL 之类刚改列报的公司短期缺几个 TTM 指标，是正确的行为。
4. **银行与保险。** 本方案只给它们最小集合。NIM、拨备、CET1、综合成本率要专门的概念映射，另开方案。

## 实现状态

**P0（2026-10-19）已实现，未发布：**

- `shared/analysis-contract/findings.ts`：`FindingBaseRef` 新增 `{ derived }`，`DERIVED_METRICS` 15 项（比设计多出 `netExternalFunding`、`cashRunwayMonths`、`debtDueCoverage` 三个，让外部融资依赖、现金跑道、到期覆盖也成为可画、可引用的单个引用）。
- `shared/analysis-runtime/findings.ts`：`derivedAt` 按上表公式解析，每个输入都必须解析到，不把缺失当零；`DERIVED_FORMULA` 给出公式文本；`cashFlowSpan`、`operatingGroup`、`Point` 导出供体检与桥使用。`highlights.ts` 的 `refView` / `ratioForm` / `higherIsBetter` 与 `lens/compile.ts` 的默认配色认识 derived。
- `shared/analysis-contract/statement-analysis.ts`：`STATEMENT_METRICS` 41 个指标（六维度，含银行/保险的 ROA 与估值五项）、`STATEMENT_RULES` 25 条（设计表之外拆出 `gross-margin-compression`，`fcf-turned` 拆成转正/转负两条）、输出类型。契约里只有数据，没有函数（边界检查要求）。
- `shared/analysis-runtime/statement-analysis.ts`：`assessStatements(data, periodEnd, locale)`、`cashBridge`、`capitalChain`、`ruleThreshold`、`metricAnchors`。规则比较带 1e-6 的容差，避免浮点噪声把"增速不变"读成"放缓"。每个指标读 13 季（显示 9 季，后面 4 季供同比）。
- `workers/pipeline/test/statement-analysis.test.ts`：标准、金融、保险三种列报的合成公司，16 季；覆盖 derived 公式、目录/规则一致性、阈值文本双语、资本开支周期/应收/到期墙/高回报的命中与不命中、烧钱公司的融资与 FCF 规则、银行不启用 capex 指标、保险隔季缺表的覆盖计数、桥合拢、链路指数化。

未做（P1 起）：页面、账本接入、分析师 `plan` 改读 flags、同业排名。

**P1–P3（2026-10-19）：**

- **P1 三表视图**：舞台第四个视图"三表体检"（`apps/business-site/src/Checkup.tsx`）：头部六维度条（命中数按级别、覆盖 n/m，点击滚到该维度）；"利润到现金"瀑布（季度 / 近四季切换，期初期末现金，未合拢时标出）；"资本链路"四条指数线；按维度的指标板（值、同比、迷你图、阈值虚线、同业名次）。rail 新增"三表体检"区（警示在前，行 = 级别形状 + 指标 + 值 + 规则公式）。聚焦一条为 `FlagLens`：走势图带阈值线与命中区间、数据表、构成图（比率的分子分母 / 差值的两条增速）、同业表、相关要点、来源。逐条浏览先走体检项再走要点。`?view=checkup`、`?flag=<rule>` 可分享。
- **P2 点亮与 AI 接入**：利润 / 现金流 / 资产负债表视图在没有本视图要点时，由本视图前三条体检项领起并点亮其锚点；数字条中被体检项指向的数字带级别标记与下划线。账本加入 derived 行、ROE / ROIC / 净债务÷EBITDA / 外部融资依赖 / FCF 率与 `flags`；写作者提示词要求每条警示被一条要点解释或反驳；`FINDINGS_VERSION` 升到 v10，指纹含 `STATEMENT_ANALYSIS_VERSION`。分析师 `planFinding` 的数值阈值删除，改由体检规则开线（`LINE_RULES`）。`PEER_FIGURES` 加 `receivables`、`currentAssets`、`currentLiabilities`，`PEERS_VERSION` 升到 v3；`/capital` 读路由带上公司与其可比同业的投影切片，`peers.published` 同时修订 `capital`，可比同业的行变化也会通知该公司。
- **P3 首页**：要点公司的体检命中数一行（警示多的在前），点开即该公司的三表体检。

与设计的出入：

- 留意级别用成本色（琥珀），不用要点的 watch 灰色：三级要一眼分得开。级别同时用形状区分（三角 / 实心圆 / 空心圆）。
- 新增规则 `backlog-large`（RPO ÷ 近四季营收 > 1×，提示级），替代分析师原来"RPO/季度营收 > 2"的需求转化触发。
- 首页没有公司卡片，改为一条公司胶囊带；只覆盖已有要点的公司，避免为首页多读每家公司的报表（公共读取限速 60 次/分钟）。
- 同业名次只对业务标签配对中口径为"整体可比"（basis company）的同业排，不用"共享类别"兜底：线上验收时类别兜底把 JPM 与 AAPL、NBIS 排在一起。2026-10-19 线上只有 CRWV 有一家整体可比同业（NBIS），不足两家，因此暂无公司显示名次；配对增多后自动出现。
- 比率的分母不大于零时不取值（经营现金流 ÷ 净亏损不是"现金低于利润"）；折旧摊销与股权激励在报表行不能对账的季度用 SEC 序列补齐（`depreciationAmortization`、`stockCompensationExpense`）。
- 估值维度在 SEC 数据源下没有倍数序列，维度条不显示无任何可解析指标的维度。
- 未做：规则命中作为主动发现的信号源（主动发现本身尚未实现）；指标的术语解释（开放问题 1，需要决定）。

**2026-10-19 前端改版：分析放进现有三张表里。** 用户不要单独的"三表体检"板块，改为：

- 去掉舞台第四个视图、rail 的"三表体检"区、首页的体检胶囊带；逐条浏览只走要点。
- 每个指标按其引用归入一张表（`refView`：利润表——增长、利润率、费用率、税率、ROE、ROIC、资产周转；现金流量表——现金转化、应计项、营运资本、SBC、资本开支强度、FCF、自给率、外部融资、利息负担、现金跑道；资产负债表——RPO、应收与存货增速、固定资产形成、净债务÷EBITDA、现金÷债务、流动比率、到期覆盖、增量资本回报）。
- 每张表在数字条下方一行列出本表命中的规则（级别形状与颜色、指标、值、规则公式）；悬停点亮图上对应节点或色带，点击打开该指标。没有本表要点时，本表规则一起点亮。
- 图下方面板：利润表默认是原来的营收走势，旁边"走势 | 指标"切换；现金流量表与资产负债表默认显示本表指标（命中的排在前面），也可切回走势。
- 点开任一指标（`?check=<metricId>`）：走势与全部阈值、数据、构成、同业、相关要点、来源；盈利质量与自由现金流类指标附"利润到现金"瀑布，资本效率类附"资本链路"。
