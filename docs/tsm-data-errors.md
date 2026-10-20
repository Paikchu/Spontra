# TSM 后端数据错误调查与解决方案

调查时间：2026-10-15 07:00–07:10 UTC。数据来源：生产 D1 `earning-report-analysis-sec-web`、SEC EDGAR 原文件，以及在本地用仓库内解析器（`workers/analysis/src/financial-data/*`）对 TSMC 实际文件的复现。

## 结论

TSM 已经通过后台白名单（`financial_company_settings`，2026-10-15 06:51:52 启用）进入采集流程，归档和文库任务都跑完了，`pipeline_dead` 中也没有死信。报错集中在**财务数据抽取**：TSMC 是外国私人发行人，年报是 20-F，季报通过 6-K 附件发布，报表采用 **IFRS 准则、以新台币（NT$）计价**。现有抽取器按美国公司（US-GAAP、美元、10-Q/10-K）设计，因此一个季度都没有读出来，最终状态为 `unavailable / MISSING_TWO_QUARTERS`。

后台列出的 34 条 issues 加 30 条文库提示，主要由同一个根因放大而来（每份 6-K 各记一条），加上两类误报。真正需要修的是 3 处代码。

| # | 报错 | 数量 | 性质 | 优先级 |
|---|---|---|---|---|
| E1 | `MISSING_TWO_QUARTERS`（采集任务 `unavailable`） | 1 | **根因**：季度报表一个也没解析出来 | P0 |
| E2 | `<accession>:NO_DIRECT_COMPARABLE_QUARTER` | 32 | 由 E1 放大，其中 27 份 6-K 本来就不含财报 | P1 |
| E3 | `UNSUPPORTED_SOURCE_FACTS:46` | 1 | 20-F 封面和薪酬披露中的文本型 iXBRL 转换未实现，不影响财务数字 | P3 |
| E4 | 文库 `ITEMS_NOT_FOUND` | 30 | 误报：6-K 本身没有 Item 结构 | P2 |
| — | AI 卡片、分析、业务脑图没有 TSM 数据 | — | 不是报错：配置范围或排队中 | — |

## 当前状态快照

- `financial_maintenance_tasks` 48f7cfd3：`status=partial, stage=complete`，issues 共 34 条（见上表）。
- `financial_collection_jobs` admin:48f7cfd3：`status=unavailable`、`attempt=3`、`reasons=["MISSING_TWO_QUARTERS"]`，`cursor.foreign=true`，扫描了 32 份文件（31 份 6-K 和 1 份 20-F，时间范围为 2026-03-17 至 2026-10-08）。
- `financial_complete_current` 中没有 TSMC（CIK 0001046179）的记录，地图上没有 Sankey。
- `sec_documents`：38 份文件全部 `ready`，其中 30 份 6-K 主文件带 `ITEMS_NOT_FOUND`。
- `pipeline_log`：filing.archived ×38、library.prepared ×38、library ×3 done、map-derive ×4 done，**没有 failed**。
- `pipeline_due`：`library-cards` 于 07:07:51 到期，属于正常防抖等待。

## E1 `MISSING_TWO_QUARTERS`：季度报表解析失败（根因）

Sankey 至少需要两个可比季度（`shared/analysis-runtime/financial-data/completeness.ts:29`）。TSMC 的季度数字只出现在两类来源中，而两类来源都被现有代码拒绝了。

### E1a：6-K 季度合并报告（非 XBRL HTML 表格）被 4 道关卡拦下

季度财报位于 6-K 附件，例如 Q2 的 `0001046179-26-000541/a2026q2consolidatedreport-.htm`（4.8 MB，**没有 iXBRL**）和 Q1 的 `…-26-000278/a2026q1consolidatedreport-.htm`。这类文件走 `readStatementTableFacts`（`workers/analysis/src/financial-data/statement-table.ts`）。本地复现结果为 `facts 0 → NO_DIRECT_COMPARABLE_QUARTER`，逐关检查如下：

| 关卡 | 代码期望 | TSMC 实际 | 结果 |
|---|---|---|---|
| ① 标题 | `consolidated statements of (operations\|income\|loss)` | `CONSOLIDATED STATEMENTS OF COMPREHENSIVE INCOME` | ✗ 中间多了 comprehensive |
| ② 币种与单位 | `in thousands/millions` 且出现 USD 或 `$` | `(In Thousands of New Taiwan Dollars, …)` | ✗ 只认美元，Fact 的 currency 也写死为 `'USD'` |
| ③ 期间表头 | `^(Three\|Six\|Nine) months ended June 30,?$` | `For the Three Months Ended June 30`，年份在下一行 | ✗ 前缀 `For the` 不匹配 |
| ④ 行标签 | `revenue / total revenues / income from operations / net income …` | `NET REVENUE (Notes 20, 31 and 37)`、`COST OF REVENUE (…)`、`GROSS PROFIT`、`INCOME BEFORE INCOME TAX`、`INCOME TAX EXPENSE (Notes 4 and 24)` | ✗ `net revenue` 不在映射表中；只去掉了 `(\d+)` 形式的脚注，`(Notes …)` 没有去掉 |

列对齐没有问题：年份单元格（列 2/6/10/14，跨 3 列）与 Amount 列起点一致，`%` 列不会被当成金额。

### E1b：20-F（iXBRL）用的是 IFRS 标签，映射表只有 US-GAAP

`parser.ts` 中的 `tags` 和 `flowConcepts` 只认 US-GAAP 概念的 local name。以下是 TSMC 20-F 的实际标签：

| 指标 | 代码认的 | TSMC 用的 | 在 20-F 中出现次数 |
|---|---|---|---|
| revenue | RevenueFromContractWithCustomer…/Revenues/SalesRevenueNet | `ifrs-full:Revenue` | 6 |
| cost | CostOfRevenue/CostOfGoodsAndServicesSold | `ifrs-full:CostOfSales` | 4 |
| operating | OperatingIncomeLoss | `ifrs-full:ProfitLossFromOperatingActivities` | 4 |
| pretax | IncomeLossFromContinuingOperationsBefore… | `ifrs-full:ProfitLossBeforeTax` | 8 |
| tax | IncomeTaxExpenseBenefit | `ifrs-full:IncomeTaxExpenseContinuingOperations` | 10 |
| marketing | SellingAndMarketingExpense/SellingExpense | 自定义行 “Marketing” | — |

目前只有 local name 恰好相同的 `GrossProfit / ResearchAndDevelopmentExpense / GeneralAndAdministrativeExpense / ProfitLoss` 被读到（采集游标 `reportedFacts` 中正是这 4 种），**没有 Revenue**，所以 `if(!figures.revenue)continue;` 会丢掉每个期间。

另外有两点：
- 20-F 只有年度期间（364/365 天），本身不会产出季度。修好标签之后，它的作用是提供年度累计值，用来推导 Q4（FY − 9M），以及做跨期核对。
- 20-F 对最新一年同时给出 **TWD 和 USD 便利换算**两套值（本地复现：`GrossProfit USD 364d`、`ProfitLoss USD 364d` 等）。它们按币种分桶，可能被当作另一个“期间”。应只采用报表的列报货币（TWD），USD 便利换算需要排除。

### E1 修复方案

1. **`statement-table.ts`：支持 IFRS 和非美元报表**（保持“无公司特例”的原则）
   - 标题允许 `consolidated statements? of (comprehensive )?(operations|income|loss)`，以及 `profit or loss (and other comprehensive income)?`。
   - 币种从标题括号内解析，写入 Fact.currency：`New Taiwan Dollars → TWD`，并预留 JPY/EUR/KRW 等。去掉写死的 `'USD'`。识别不出币种时继续拒绝，**不能默认成美元**。
   - 表头允许可选前缀 `For the`，且年份在下一行时不需要逗号。
   - 标签归一：去掉 `\((?:Notes?|Note)\s[^)]*\)` 后再转小写；增加 `net revenue → Revenues`、`cost of revenue → CostOfRevenue`、`gross profit → GrossProfit`、`total operating expenses → OperatingExpenses`、`income before income tax → …BeforeIncomeTaxes…`、`income tax expense → IncomeTaxExpenseBenefit`、`marketing → SellingAndMarketingExpense`。
   - 去掉 “Only … explicit USD scale” 的限制之后，需要同步更新文件头注释和 `currency` 字段。
2. **`parser.ts`：`tags` 增加 IFRS 概念**：revenue `+Revenue`，cost `+CostOfSales`，operating `+ProfitLossFromOperatingActivities`，pretax `+ProfitLossBeforeTax`，tax `+IncomeTaxExpenseContinuingOperations`，sales `+SellingExpense/DistributionCosts`。`local()` 会去掉前缀，因此加 local name 即可。
3. **USD 便利换算**：对 foreign 发行人，只保留与报表主币种（`ifrs-full:Revenue` 出现次数最多的 unit）一致的 Fact。
4. **下游显示**：Sankey 和高亮卡片目前假定是美元。需要检查 `BusinessFlowQuarter.currency` 是否一路透传到前端格式化（`NT$`），避免把 1.27 万亿新台币显示成 “$1.27T”。
5. 修改解析逻辑后，**把 `SEC_FLOW_PARSER_VERSION` 升到 `deterministic-sec.v12`**，游标会自动重扫。

## E2 32 条 `<accession>:NO_DIRECT_COMPARABLE_QUARTER`

来源是历史步骤 `runHistoryStep`（`workers/analysis/src/financial-data/history.ts`）：凡是没有解析出季度的文件，都会记一条 `${accession}:${issue}`。32 份候选文件中：

- 4 份是季度财报（Q1、Q2 的 earnings 6-K 和 consolidated report 6-K），修好 E1 后会消失。
- 1 份是 20-F，修好 E1b 后仍然只有年度数据，会继续报，这是正常结果。
- **27 份是非财报 6-K**：月营收（`tsm-revenue*`）、月末报告（`tsm-monthend6k*`）、董事会决议、股利调整、股东会、Sony/VIS 交易公告等。它们本来就没有季度报表，却占用了 foreign 发行人 32 份的扫描名额（`provider.ts` 中的 `cursor.foreign?32:10`），导致窗口只覆盖了约 7 个月，2026 年 1 月发布的 Q4'25 财报 6-K 不在范围内。

**修复**：在 `provider.ts` 的文件挑选和 `history.ts` 的 `listDocuments` 中，对 6-K 先读文件索引，只保留附件中含 `consolidated statements|consolidated report|management report|earnings release` 的 6-K。或者更简单地，6-K 没有解析出季度时不计入 issue（与 `8-K` 非 2.02 项的处理方式一致）。名额应按“财报 6-K”计数，保证至少覆盖最近 5 个季度。

## E3 `UNSUPPORTED_SOURCE_FACTS:46`

由审计步骤（`financial-maintenance-runner.ts:93`）统计 20-F 的 iXBRL 清单得出。本地复现 46 条全部是 `unsupported_transform`：

| 转换 | 数量 | 位置 |
|---|---|---|
| `ixt-sec:duryear` | 33 | 期限类文本（如 “5 years”） |
| `ixt-sec:durwordsen` / `numwordsen` | 4 / 3 | 英文数词 |
| `ixt-sec:countrynameen` / `edgarprovcountryen` / `exchnameen` | 2 / 1 / 1 | 封面国家、交易所 |
| `ixt:date-monthname-day(-year)-en` | 2 | 日期 |

这些都是封面或附注中的文本值，**不涉及任何损益表或资产负债表数字**，原文也完整保留了。

**修复**（低优先级）：在 `shared/analysis-runtime/financial-data/disclosure-extraction.ts` 中实现上述 ixt-sec 转换。也可以只对 numeric 类财务事实计入 `UNSUPPORTED_SOURCE_FACTS`，文本类事实单独计数，不进入 issues。

## E4 文库 `ITEMS_NOT_FOUND` ×30（误报）

`shared/analysis-runtime/filing-library/parse.ts:440` 要求 6-K 主文件至少找到 1 个 Item（`/^(?:8-K|6-K)/ ? 1 : 2`）。8-K 有 Item 2.02 等编号，**6-K 没有 Item 体例**，是一页封面加附件，所以每份 6-K 都会触发这个提示。文件状态仍然是 `ready`，切分和检索不受影响。

**修复**：6-K 不要求 Items（`structured` 判定只对 10-K/10-Q/20-F/8-K 生效）。改动后需要升级文库解析器版本，让已有文件重新切分。

## 不属于报错的部分

- **AI 卡片（library-cards）**：07:07:51 到期的防抖任务，随后会运行，不需要处理。
- **AI 分析 / 业务脑图 / 电话会**：`SEC_AI_TICKERS=ORCL`，`BUSINESS_TREE_TICKERS=MSFT,ORCL,NVDA,ADSK,NET`，TSM 不在其中，所以没有运行。如果需要，在 wrangler 变量或后台分别加入。前提是 E1 修好，否则脑图没有收入树可以对齐。
- **20-F 体积**：10.36 MB，接近 `readBoundedReport` 的 12 MB 上限。以后年份如果超过上限，会报 `SEC_DOCUMENT_UNAVAILABLE`，需要关注。

## 实施顺序与验证

1. E1（statement-table 支持 IFRS 和多币种、parser 增加 IFRS 标签、排除 USD 便利换算、前端币种），并把解析器版本升到 v12。
2. E2（过滤非财报 6-K）。
3. E4（6-K 豁免 Items），以及 E3（可选）。

验证方法：

- 单测：用 `a2026q2consolidatedreport-.htm` 的报表片段作为 fixture，断言得到 2026Q2/2025Q2 的 3M 期间，`currency=TWD`，revenue=1,270,380,250×10³，cost=410,069,555×10³，并且 Q1 可由 6M−3M 推出。另加一个 20-F 片段，断言读到 `ifrs-full:Revenue`，且 USD 便利换算不进入结果。原有 US 公司的 fixture 必须全部保持不变（`npm run test:analysis`）。
- 上线后在后台对 TSM 重新执行 extract，核对：`financial_collection_jobs.status=succeeded`、`financial_complete_current` 出现 CIK 0001046179、issues 中不再有 `MISSING_TWO_QUARTERS` 和 27 条非财报 6-K 记录，地图上 TSM 的 Sankey 以 NT$ 显示。

## 复现脚本

本地探针脚本位于会话 scratchpad（`scripts/probe.ts`、`gates.ts`、`audit.ts`、`cols.ts`），用法是 `node --experimental-strip-types` 直接导入仓库中的解析器，对 SEC 原文件运行，不写任何数据。

## 实施结果（2026-10-15）

按上文方案实施，与方案不同之处：

- **20-F 收入标签**：TSMC 损益表的营收行是 `ifrs-full:RevenueFromContractsWithCustomers`（94 处）。`ifrs-full:Revenue` 只有 6 处，且都带维度。`tags.revenue` 两个都加，`Revenue` 优先。
- **营业费用桥**：TSMC 的 `Total operating expenses`（98,982,083）不含 `OTHER OPERATING INCOME AND EXPENSES, NET`，所以毛利 − 营业费用 ≠ 营业利润。新规则（不限于表格路径）：报出的营业费用合计接不上毛利到营业利润时，营业费用改为推导值“毛利 − 营业利润”（93,708,044），费用构成取毛利与营业利润之间的各行，包括这条其他营业收益（显示为 −5,274,039 的抵减项）。哪一行按收益方向计入，由报表自身的算术决定：每个期间列都要对平，且最多只翻转一行。不依赖文字判断。
- **币种**：报表主币种取 flow facts 中出现次数最多的币种，其他币种的 fact 丢弃。这条规则对所有 iXBRL 文件生效；只有一种币种的文件不受影响。
- **6-K 过滤**：在封面上判断。附件索引（含 99.x 的行）提到 financial statements/results、earnings、consolidated/management report，或封面本身印有损益表，才算财报 6-K。其余 6-K 照常归档，但不解析、不记 issue，也不占名额。外国发行人的 6-K 按提交日期列入（provider 回看 550 天，history 回看 1185 天），名额只计财报文件（32 份）。每步最多跳过 12 份通知类 6-K。
- **版本**：期间 origin/main 已把 `SEC_FLOW_PARSER_VERSION` 用到 v12（71c9f32），本次升到 `deterministic-sec.v13`；`sec-revenue-history.v6`、`filing-library.v3`。
- **前端**：`TWD → NT$`（`locale.ts`、`business-flow-layout.ts`）。每股金额在非美元时不再写死 `$`。

验证：`workers/analysis/test/foreign-filer.test.ts`，fixture 取自 TSMC 原件，共 9 项。本地用真实 SEC 数据跑 TSM 采集：第一步跳过 5 份通知类 6-K，由 Q2 合并报告得到 2026-06-30 / 2026-03-31 两个 NT$ 季度，`checkCompleteFlow` 通过。MSFT、NVDA、ADSK、NET、AMZN、GOOGL、META、ORCL 的最新 10-Q/10-K 及 8-K 附件，解析结果与 origin/main 逐字节相同。

仍未覆盖：Q4 季度。TSMC 的年度合并报告只给全年数据，Q4 只能从 1 月的 earnings release 获得；该新闻稿当前不能解析。如果 1 月以后最新季度是 Q4，需要另行处理。
