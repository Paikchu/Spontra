# 要点驱动的财报与事件方案

日期：2026-10-09。状态：P1 与内幕交易 lens 已实现（见文末“已实现”），其余分期待做。

## 一句话

把“财报与事件”时间线并入“要点”：时间线不再是一个独立 tab，而是画布的时间轴；每一份 10-Q/10-K 产出一组“本期要点”，每一份 8-K、Form 4 产出一条“事件要点”；用户只和要点打交道，要点在画布上用图说话，原文链接始终一步可达。

## 现状（可复用的部分）

| 已有能力 | 位置 | 可直接复用 |
| --- | --- | --- |
| SEC 申报抓取：每家公司最近 40 份 submissions，含 8-K 的 `items` 字段，12 小时刷新 | `workers/pipeline/src/sec/pipeline.ts` `fetchSecFeed`、`sec.ts` `parseSecSubmissions` | 是，需补 Form 4 |
| 8-K/6-K 事件简析：headline、3–5 条 bullets、analystView、`eventCategory`（earnings_update/guidance/m&a/executive/legal/other） | `pipeline.ts` `summarizePreparedSecEvent` | 是，作为事件要点的文字层 |
| 10-Q/10-K 结构化报告、XBRL 事实、同比环比 | `sec/analysis.ts`、`report.ts` | 是 |
| 要点合同与校验：要点不带数字，数字在读取时从已发布数据解析，解析不到就不展示 | `shared/analysis-contract/findings.ts`、`shared/analysis-runtime/findings.ts` | 是，要扩一种 ref |
| 要点写作流程：ledger → DeepSeek → verify → 发布，`*/10` cron 扫描，admin 可手动触发 | `workers/pipeline/src/findings/*`、`admin/ai-runs.ts` | 是 |
| 画布：Sankey（利润）、资金池（现金流/资产负债）、lens（trend/compare_bars/share_area/ladder）、逐条看、对照拆分、watch 回看 | `apps/business-site/src/BusinessMap.tsx`、`LensPanel.tsx` | 是 |
| 指引合同：每条指引带原文引用、修订动作、实际值 | `shared/analysis-contract/guidance.ts` | 是 |
| 老的财报与事件 tab：按申报日分页的 accordion，每份 summary、keyMetrics、EDGAR 链接 | `app/analysis/stocks/[ticker]/SecFilingsSection.tsx`、`StockDetail.tsx` 的 `sec-filings` tab | 降级为“全部申报”归档 |
| web 搜索服务（Tavily，带缓存） | `workers/pipeline/src/web-search` | 用于内幕交易背景 |

缺口：Form 4 未抓取（仓库里只剩 `earning-report.css` 的 `.sec-form-badge[data-form="4"]` 死样式）；8-K 的 `items` 只在 `sec:filings` 缓存里，`sec_filings` 表没有该列，`hydratePublicFiling` 写死 `items: ""`，前端拿不到；item 编码只有 2.02 被三处用到（guidance 的 `earnings_events` 表、financial-data 两处）；事件没有进入要点合同；画布没有时间轴；事件没有专属图。

另外两点影响方案：要点目前是“每家公司只写最新一期”，不是按申报；业务地图站 `apps/business-site` 是独立 Worker，经主应用 `/api/analysis/v1` 代理读 pipeline，和 `/positions/:ticker` 的 tab 不在同一个应用里。

## 数据层

### 1. 事件合同 `events.v1`

新增 `shared/analysis-contract/events.ts`。事件是确定性记录，不含模型判断；模型只写文字层。前置修补：`sec_filings` 增加 `items` 列（或 `hydratePublicFiling` 从 `sec:filings` 缓存补回），否则分类无从做起。2.02 事件直接复用 guidance 已建的 `earnings_events` 表。

```ts
type CompanyEvent = {
  id: string;                 // accession
  ticker: string;
  form: "8-K" | "8-K/A" | "6-K" | "4" | "4/A";
  filedAt: string; eventDate: string;
  items: string[];            // 8-K item 编码，如 ["2.02","9.01"]
  class: EventClass;          // 见下表，由 items/Form 4 确定，不由模型决定
  edgarUrl: string; documentUrl: string;
  exhibits: Array<{ type: string; title: string; url: string }>;   // EX-99.1 等
  summary: { headline; bullets; analystView; eventCategory } | null; // 复用现有事件简析
  // 下列结构化字段按 class 填一个，由确定性解析或带引文校验的抽取得到
  executive?: ExecutiveChange[];
  insider?: InsiderTransaction;
  deal?: DealTerms;
  financing?: FinancingTerms;
  capitalReturn?: CapitalReturnTerms;
};
```

事件类别由 8-K item 编码决定，模型的 `eventCategory` 只做二级标签：

| item | class | 画布图 |
| --- | --- | --- |
| 2.02（+EX-99.1） | `earnings` | 与季度要点相同的 trend/compare_bars |
| 7.01 含指引、或 2.02 附指引 | `guidance` | 指引区间 vs 实际 |
| 5.02 | `executive` | 管理层任期条 |
| Form 4 | `insider` | 持仓阶梯图 |
| 1.01 / 2.01 / 2.05 | `deal` | 并购 pro-forma 叠加 |
| 2.03 / 3.02 / 2.04 | `financing` | 资金池新增流 + 到期阶梯 |
| 8.01 含回购/分红授权 | `capital_return` | 回购额度量表 |
| 5.07 | `vote` | 投票结果条 |
| 1.05 / 8.01 诉讼监管 | `legal` | 无图，关联披露时间线 |
| 其他 | `other` | 无图 |

### 2. Form 4 抓取与解析

- `BUSINESS_FILING_FORMS` 加入 `4`、`4/A`。issuer 的 submissions 已包含以其为 subject 的 Form 4，无需按人抓取。
- Form 4 是 XML（`ownershipDocument`），确定性解析：申报人、职务、交易编码（S 卖出 / P 买入 / M 行权 / F 税务代扣 / A 授予 / G 赠与）、股数、价格、交易后持股、直接/间接、10b5-1 复选框与采用日期（2023 年起表单自带）、脚注。
- 存储：`insider_transactions` 表（一次迁移），按 ticker + 申报人 + 日期索引。Phase 1 可先存 `sec_cache` 键 `insider:v1:<ticker>:<accession>` 避免迁移，稳定后再迁表。
- 派生指标全部可从表内算出，不需要模型：本次占持仓比例、近 12/24 个月累计卖出、卖出节奏（固定间隔 → 计划性）、同一窗口内其他内部人的操作（集群）、M+S 组合（行权即卖）与 F（代扣）单独标记为低信号。
- 市值和成交量：`sec/market.ts` 只冻结日收盘，没有成交量；增加 30 日均量字段，用于“本次卖出相当于几天成交量”。

### 3. 事件进入要点

扩展 `FindingBaseRef`：

```ts
| { event: string; field: "sharesSold" | "proceeds" | "holdingsAfter" | "shareOfHoldings" | "dealValue" | "principal" | "authorization" }
```

- 解析器 `resolveRef` 对 `event` ref 从 `events.v1` 读数；写进要点文字的数字仍要在解析候选值里出现，否则整条要点被扣留。校验模型不变。
- 新增 `FindingKind: "event"`，`severity` 沿用。`lens` 新增：`{ type: "insider_ladder"; owner: string }`、`{ type: "tenure"; role: string }`、`{ type: "deal_overlay"; eventId }`、`{ type: "financing_ladder"; eventId }`、`{ type: "authorization_gauge"; eventId }`。
- 要点发布单位从“每家公司最新一期一组”改为两类并存：
  - `findings.v1`（季度要点）：不变，但 ledger 增加“上期至今的事件清单”，让季度要点可以引用事件（例如 CFO 离任与应收周转恶化放在一起）。
  - `event-findings.v1`：每个事件 0–2 条要点，事件落地后 10 分钟内由 cron 生成；指纹 = accession + summary version。

### 4. 内幕交易深挖（AI + 搜索）

分两层，数字层和背景层互不混用：

1. **数字层（确定性）**：持股阶梯、占比、节奏、集群、与市值/均量的比值。全部来自 Form 4 历史与冻结行情，可校验。
2. **背景层（模型 + web 搜索）**：问题固定为三条——“这次卖出是否属于已公开的 10b5-1 计划？”“该申报人过去一年的交易模式？”“同期是否有其他解释（纳税、离职、行权到期）？”。搜索结果走现有 `WebSearchService`，输出带来源的 `ExplainerClaim`，页面标为“背景”，不参与任何数字。
3. **结论标签**由规则给出，不由模型给出：`按计划`（10b5-1 且节奏一致）、`常规`（占比 < 5% 且非集群）、`需要留意`（占比 ≥ 10%、或 30 天内 ≥ 3 名内部人卖出、或首次卖出且无计划）。阈值放在合同常量里，页面显示触发了哪条规则。

### 5. 调度

- 现有 feed 刷新（`SecAnalysisWorkflow` discover 步，12 小时间隔，`*/10` cron 对 `SEC_AI_TICKERS` 触发）不变，Form 4 随 feed 进入；`selectWorkflowFilings` 只看最新 5 份里的 8-K，要放宽到“上次已处理之后的全部事件”。
- `*/10` 扫描新增两步：未解析的 Form 4 → 解析入库；有 summary 但无事件要点的 8-K/Form 4 → 生成事件要点。每 tick 限 1 家公司、3 个事件，与现有要点扫描共用模型日上限。
- 业绩 8-K（2.02）落地时先用 EX-99.1 生成“预读要点”，10-Q 到达后用 XBRL 重新生成并替换；替换时保留 watch 项的回看关系。

### 6. 读取 API

- `GET /api/analysis/v1/companies/:t/events?since=&limit=`：`events.v1` 列表，含每个事件的要点 id。
- `GET /api/analysis/v1/companies/:t/findings` 响应增加 `events: EventFindingsPublication[]`，或拆成 `/event-findings`。推荐拆开，季度要点的缓存节奏与事件不同。
- 老 `filings` 分页接口保留，供“全部申报”归档使用。

## 前端 UX

### 布局：时间轴成为画布的一部分

```
┌ rail ──────────────┬ stage ─────────────────────────────────────────┐
│ 要点  2026.05 财报  │ 头部：公司 · 当前期 · 利润/现金流/资产负债       │
│ ① 资本开支 557 亿  │                                                 │
│ ② 云业务占比…      │            Sankey / 资金池（随时间轴移动）        │
│ ─ 期间事件 ──────  │                                                 │
│ 06.10 业绩 8-K     │ ┌ lens ────────────────────────────────────────┐ │
│ 07.02 CFO 变更 ●   │ │ 事件专属图 + 判断 + 证据 + 来源 + 原文        │ │
│ 07.15 Ellison 卖出 │ └──────────────────────────────────────────────┘ │
│ ─ 往期 ▸ ────────  │ 时间轴：●10-K ○8-K ·F4 ━━━━━━━●━━━━○━━·━━━━━━▶  │
└────────────────────┴─────────────────────────────────────────────────┘
```

- **rail** 三段：本期要点（现有）、期间事件（上期财报至今，按日期倒序）、往期（折叠，展开后按财报期分组，带 watch 回看结果）。一条事件行 = 日期 + 类别标记 + 标题 + 严重度。
- **时间轴**放在 stage 底部，替代老 tab：大点 10-K/10-Q，中点 8-K，小点 Form 4。拖动把 Sankey/资金池切到对应期；点击事件点 = 聚焦该事件要点。事件点按 class 着色，连续卖出在轴上自然聚成一簇，不用额外说明。
- **逐条看**顺序改为时间顺序：上期要点 → 期间事件 → 本期要点，用户能看到“上期说要盯什么，期间发生了什么，本期结果如何”。
- 老 accordion 列表移到页面底部“全部申报”，保留 EDGAR 链接、分页、keyMetrics，供核对。
- 主应用 `/positions/:ticker` 的 `sec-filings` tab 改名“要点与事件”。业务地图是独立站点，两种接法：短期 tab 内放要点与事件的只读列表（复用 `FindingsList` 的数据，点击跳转地图站 `/companies/:t?finding=:id`），长期把 `BusinessMap` 抽成 `packages/ui` 组件在主应用内挂载。推荐先做跳转，地图站已支持 `?finding=` 深链。

### 阅读层级

每条要点固定四层，任一层都可停：一句结论 → 图 → 证据表（当前值、对比值、变化）→ 来源与原文。对应产品理念“先一句结论，再展开证据对照、趋势图、时间线”。

### 事件 lens 设计

**内幕交易（Form 4）**

- 左图：持股阶梯。x 为时间，y 为该申报人持股；每次交易画成台阶，卖出向下，行权向上；台阶旁的圆点面积 = 成交金额；10b5-1 交易用空心点。聚焦时该次卖出高亮，其余变淡。
- 右栏：本次 卖出 N 股 / 占交易前持股 x% / 金额 / 相当于 y 日均量；结论标签（按计划 / 常规 / 需要留意）和触发规则；节奏说明（“近 12 个月第 5 次，每次约 x%，间隔约 90 天”）；同期其他内部人一行一人；“背景”段落（搜索结果，带来源）；原文（Form 4 XML 渲染页）。
- 画布联动：资金池视图不变；若同一窗口有回购公告，时间轴上两点并列并提示“回购与内部人卖出同期”。

**高管变动（5.02）**

- 左图：任期条。每个关键职位一行（CEO/CFO/COO/董事长），横向时间，离任处断开，新任从断点起；由历史 8-K 5.02 与 10-K Item 10 确定性拼出。聚焦事件处标出“生效日”“过渡期”。
- 右栏：谁、什么职位、原因（原文引用）、是否内部提拔、前任任期长度；关联要点（例如“该 CFO 任内应收周转从 a 到 b”，由季度要点引用事件得到）。

**并购（1.01/2.01）**

- 画布叠加：Sankey 上以虚线新增标的收入节点，资金池上新增“现金支出/新增债务”虚线流，标注“公告口径，未并表”。完成（2.01）后虚线转实线，并在时间轴上连接公告点和完成点。
- 右栏：对价、支付方式、标的收入/利润（公告口径）、预计完成时间、监管条件；要点写成“对价相当于 x 年自由现金流”这类可解析的比值。

**融资（2.03/3.02）**

- 画布叠加：资金池“债务”条增加新发行段，颜色区分；lens 画到期阶梯（年份 × 本金），新发行段高亮。
- 右栏：本金、利率、期限、用途、对利息覆盖倍数的影响（由已发布数据算出）。

**回购/分红授权（8.01）**

- lens：授权量表——已用/剩余/新增；下面是近 8 季实际回购柱。
- 右栏：授权金额占市值比、过去授权执行率。

**业绩 8-K（2.02）**

- 直接复用季度要点 lens，标“预读，待 10-Q 核对”。10-Q 落地后替换，差异处标出。

**指引**

- lens：每项指引一条区间线，实际值落点着色（高于/落在/低于），修订动作用箭头。已有合同支持。

**诉讼/监管、其他**

- 无图。右栏文字 + 关联披露时间线（同主题历史 8-K 串起来）。

### 状态与边界

- 数字解析不到就不展示要点，与现有规则一致；事件文字层缺失时只显示“已申报，摘要生成中”和原文链接。
- 搜索背景不可用时，内幕交易 lens 只显示数字层；不以“无背景”推断结论。
- Form 4 的 F/A/G 编码默认折叠在“非交易类变动”，不生成要点。
- 时间轴最多显示 24 个月，更早的进“往期”。

## 分期

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P1 | `events.v1` 合同；8-K item 分类；Form 4 抓取解析与派生指标；`/events` API；rail 的“期间事件”段与时间轴；老 tab 改挂地图，归档列表下移 | 任一公司打开“要点与事件”，看到上期至今的事件按日期列出，每条可点开原文；时间轴可拖 |
| P2 | 内幕交易 lens（阶梯图、规则标签、集群）；高管任期条；事件要点生成进 cron；admin 手动触发事件要点 | ORCL 任一 Form 4 聚焦后显示占比、节奏、标签，数字可与 EDGAR 核对 |
| P3 | 搜索背景层；业绩 8-K 预读要点与 10-Q 替换；指引 lens | 预读要点与 10-Q 要点差异可见 |
| P4 | 并购 pro-forma 叠加、融资到期阶梯、回购量表；跨持仓同事件关联 | 同一事件在两只持仓页面互相可见 |

## 风险与取舍

- Form 4 由申报人提交，issuer submissions 里偶有延迟或缺失，页面标“截至 EDGAR 最近同步”。
- 事件要点数量会远多于季度要点，rail 默认只显示上期至今，避免淹没本期要点。
- 搜索背景是唯一的非确定性来源，必须和数字层分区显示，并保留来源链接。
- 迁移：`insider_transactions` 表属于 Pipeline 数据库，按 AGENTS.md 要先完善自动发布的迁移流程再上线；P1 用 `sec_cache` 键过渡。

## 已实现（2026-10-09）

- 合同 `shared/analysis-contract/events.ts`（`events.v1`）与运行时 `shared/analysis-runtime/events.ts`：按 8-K item 编码分类、zod 校验、内幕交易派生指标（占比、节奏、集群、规则标签、持股路径）。
- Pipeline `workers/pipeline/src/events/`：`form4.ts` 解析 ownershipDocument XML；`workflow.ts` 的 `runEventsSweep` 挂在 `*/10` cron 的 allSettled 列表里，读 EDGAR submissions（6 小时一次）、Form 4 XML（每 tick 每公司 8 份）、申报索引页附件（6 份），复用 `sec_filing_summaries` 里已有的事件简析；一切写入 `sec_cache`（`events:v1:`、`insider:v1:`、`exhibits:v1:`），无迁移、无模型调用。`EVENTS_ENABLED=false` 可暂停。
- 读取 API `GET /api/v1/companies/:t/events`（OpenAPI 已登记），主应用代理 `/api/analysis/v1/companies/:t/events`，地图站 `/api/business/v1/companies/:t/events`。
- 地图站：rail 在要点下新增“期间事件”段（上期财报申报日起，不足三条放宽到 90 天 / 最近五条；更早折叠；授予代扣赠与只计数）；stage 底部新增时间轴（报告为方点、8-K 为圆点、Form 4 为小点，按类别着色，点报告切期，点事件开 lens）；事件 lens：Form 4 画持股阶梯（台阶 = 申报后持股，圆点面积 = 金额，空心 = 10b5-1，聚焦项发光）并给出规则标签与触发规则；8-K 列条款、附件、摘要与 EDGAR 链接。`?event=` 深链；与要点聚焦互斥。
- 财报内容迁入地图（2026-10-09 第二次提交）：地图站 worker 新增 `/filings`（上游 `PublicFilingPage` 压成 `PublicFilingDigest`：财季标签、标题、要点、投资含义、补充分析、关键数据带同比环比、叙述变化、指引与风险、核验状态、来源文件与 EDGAR 链接）和 `/filings/:accession?reportDate&reportVersion`（完整报告原样透传）。rail 的"期间事件"改为"财报与事件"：财报与事件按时间混排，业绩期合并进财报的 8-K 只列一次；时间轴的报告点改由申报列表提供；财报 lens 左侧关键数据卡与叙述变化，右侧结论与来源；"阅读完整报告"在地图内用 `SecReportDocument` 以模态方式渲染（lazy chunk，带 earning-report 样式与 KaTeX）。`?report=` 深链。主应用的 `/positions/:ticker` 旧 tab 未改动。
- 未做：业绩 8-K 预读要点、搜索背景层、高管任期条、并购/融资/回购叠加、逐条看跨事件、30 日均量。
- 地图站已直连 pipeline 读 API（2026-10-09 第三次提交）：`apps/business-site/wrangler.jsonc` 绑定 `EARNING_REPORT_PIPELINE` → `spontra-analysis`，Worker 用自己的 `EARNING_REPORT_READ_TOKEN` 走 `/api/v1/companies/:t/*`，不再经过 spontra-app。上线前需在 pipeline 的 `ANALYSIS_READ_KEYS` 加一把地图站的 key，并给 `spontra-business-map` 设置同名 secret（或在主构建 secrets 里设 `BUSINESS_SITE_READ_TOKEN` 由 CI 写入）。
