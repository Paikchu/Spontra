# 白名单管理：按页面功能设置开关

日期：2026-10-17。状态：已实施（同日），实施差异见文末。

## 问题

白名单页每家公司现在有三组开关：加入/移出白名单、「AI 分析」一个总开关、「业务脑图」生成与显示。「AI 分析」对应的是 Pipeline 的 `scope: "ai"` 名单（`SEC_AI_TICKERS` 加 `financial_ai_settings`），一个开关同时控制财报摘要、业绩指引、公司分析、要点、分析师档案和业务解读六条任务。管理员看到的是「AI / 非 AI」这条实现上的分界，而不是读者页面上的功能；想只开一家公司的要点、或只关业务解读，做不到。

## 页面上的功能与它们的数据来源

读者看到的 BusinessView（首页与公司页）由下面几块组成。每块列出产出它的任务、现在的名单，以及没有数据时页面的表现。

| 页面功能 | 页面位置 | 任务（registry.ts） | 现在的名单 | 缺数据时 |
|---|---|---|---|---|
| 财务地图 | 公司页舞台：利润 / 现金流 / 资产负债三张图、趋势、收入构成、「文件与事件」里的事件、同业数字 | `collect`、`history`、`map-derive`、`presentation`、`events`、`peers`、`library*`、`translate` | 白名单（`scope: "data"`） | 公司页 404 / 未就绪 |
| 财报摘要与指引 | 「文件与事件」里的财报卡（标题、摘要、8-K 摘要）、财报镜头、图上的业绩指引标记 | `sec-report`、`guidance` | AI 名单 | 事件轨只列申报，无摘要；图上无指引标记 |
| 要点 | 公司页「要点」栏、要点镜头、统计高亮、分析师档案；首页「要点」跑马灯 | `memory`、`company-analysis`、`findings`、`analyst` | AI 名单 | 栏目不出现；首页不列该公司 |
| 业务解读 | 点业务后的业务概况（是什么、客户、收入模式） | `explainer` | AI 名单 | 退回财报原文档案 |
| 业务脑图 | 桑基图左侧的业务树与节点说明 | `tree` | `BUSINESS_TREE_TICKERS` 加 AI 名单，再按 `business_tree_settings` 增删 | 显示文字档案 |

依赖关系只有一条链：要点读取 `sec-report` 发布的基本面（`fundamentals.updated`）、指引（`guidance.published`）和公司分析（`analysis.published`，由 `report.published` 经 `memory` 触发）。财报摘要关了，要点就没有新的触发源。业务解读、业务脑图各自只依赖财务地图。

## 方案

### 开关模型

每家公司四个功能开关，与上表后四行一一对应：**财报摘要**、**要点**、**业务解读**、**业务脑图**。财务地图就是白名单本身（加入 / 移出），不另设开关。

每个功能开关沿用业务脑图今天的两位语义（生成、显示），但在页面上收成一个三档分段控件：

| 档 | generate | display | 含义 |
|---|---|---|---|
| 关 | 0 | 0 | 不再启动新运行；已发布内容对读者隐藏，存储保留 |
| 生成 | 1 | 0 | 运行，读者看不到；用于先在后台核对再放出 |
| 显示 | 1 | 1 | 运行并展示 |

「显示但不生成」（今天脑图可以配出来的 generate=0, display=1）仍是合法的存储状态：关掉生成后已发布的内容继续显示直到管理员选「关」。控件把它显示为「显示」，并以小字标出「已停止生成」。这样四个功能的行为一致，脑图不再是特例。

全局开关：每个功能一个，存 ticker `'*'` 行，显示在表头该列的标题旁（今天「业务脑图生成（全部公司）」的位置）。全局关闭等于把该功能每家公司的生成都暂停，已排队的运行以 superseded 结束，显示状态不变。

依赖：要点的「生成」要求财报摘要处于生成或显示；把财报摘要切到「关」时，页面提示并同时把要点切到「关」（或拒绝，二选一，建议拒绝并说明原因，避免一次点击改两处）。其余功能互不依赖。四个功能都要求公司在白名单内，移出白名单时四个功能保持存储值不动、控件禁用（与今天「AI 分析」开关的禁用规则一致）。

### 存储

新表 `business_feature_settings`，替代 `financial_ai_settings` 和 `business_tree_settings`：

```sql
CREATE TABLE business_feature_settings (
 ticker TEXT NOT NULL,          -- '*' 为全局行
 feature TEXT NOT NULL CHECK (feature IN ('reports','findings','explainer','tree')),
 generate INTEGER CHECK (generate IN (0, 1)),   -- NULL 用部署默认
 display INTEGER CHECK (display IN (0, 1)),     -- NULL 视为显示
 updated_at TEXT NOT NULL,
 PRIMARY KEY (ticker, feature)
);
```

迁移在同一文件里回填：`financial_ai_settings` 的每一行写成 `reports`、`findings`、`explainer` 三行（generate = enabled，display NULL）；`business_tree_settings` 逐行写成 `tree`。旧表保留一次发布周期再删（迁移只增不减，符合现有约定）。

部署默认不变：`SEC_AI_TICKERS` 是 `reports`、`findings`、`explainer` 三个功能的默认名单，`BUSINESS_TREE_TICKERS` 加 AI 名单是 `tree` 的默认名单，`SEC_AI_ENABLED`、`BUSINESS_TREE_ENABLED` 是对应的全局默认。

### 名单解析（company-policy.ts）

`companyPolicyEnvironment` 今天把两张表解析成 `SEC_AI_TICKERS` 和 `BUSINESS_TREE_RESOLVED`。改为解析出四个名单，放在一个 `FEATURE_RESOLVED` JSON 环境字段（`{reports:[...],findings:[...],explainer:[...],tree:[...]}`）加对应的全局启用标记。`trackedTickersFor(env)` 保留为 `reports` 名单的别名，方便 `memory-workflow.ts`、`admin/reports.ts` 这类只关心财报摘要的调用点逐个改名；`treeTickersFor` 改读 `FEATURE_RESOLVED.tree`。

registry 的 `TaskScope` 从 `"data" | "ai" | "tree" | "global"` 改成 `"data" | "reports" | "findings" | "explainer" | "tree" | "global"`：

| 任务 | scope |
|---|---|
| `sec-report`、`guidance` | `reports` |
| `memory`、`company-analysis`、`findings`、`analyst` | `findings` |
| `explainer` | `explainer` |
| `tree` | `tree` |

`router.ts` 的 `scopeTickers` 按 scope 读对应名单；`validateRegistry` 不变。

### 事件

`ai.enabled` 和 `tree.settings` 合并为一个 `feature.settings` 事件，`detail.feature` 标明是哪个功能。订阅：

```ts
"feature.settings": [
  { task: "sec-report", when: e => e.detail?.feature === "reports" },
  { task: "findings",   when: e => e.detail?.feature === "findings" },
  { task: "explainer",  when: e => e.detail?.feature === "explainer" },
  { task: "tree",       when: e => e.detail?.feature === "tree" },
],
```

每次切换都发出一次，与今天 `tree.settings` 一样：打开生成时让任务检查是否需要运行，切换显示时让地图的 company 版本号前进，读者立刻看到变化（`revisions.ts` 把 `feature.settings` 加进推动版本号的事件）。`EventDetail` 加 `feature?: Feature` 字段。

### 读取侧（显示开关）

业务脑图今天在 `readBusinessTreeResponse` 的 `public` 读里返回 `status: "hidden"`。其余三个功能照做：

- `reports` 隐藏：`filings` 资源的每份申报去掉 `headline`、`summary` 等摘要字段，只留表单、日期、期间（事件轨照常列出申报）；`guidance` 返回 `status: "hidden"`。
- `findings` 隐藏：`findings` 返回 `status: "hidden"`；首页的 `findings-index` 过滤掉隐藏的公司（现在是 `LIKE 'findings:v2:%'` 的存储扫描，改为与设置表联查）。
- `explainer` 隐藏：`business-explainer` 返回 `status: "hidden"`。

后台读取不受显示开关影响。公开读取接口保持只读 D1、不挂钩子（docs/pipeline-events.md 原则 2）。

### 其他调用点

- `storage/sweep.ts` 的 `aiTickers`（删除不在 AI 名单内公司的死信与分析对象）改为 `reports ∪ findings` 的生成名单。
- `admin/ai-runs.ts` 的 `enabled(kind)` 按 kind 查对应功能名单：`guidance` 查 `reports`，`findings`/`analyst` 查 `findings`，其余同名。
- `admin/reports.ts`、`admin/financials.ts` 里的 `trackedTickersFor` 含义是「财报摘要是否开启」，改名后语义不变。
- `BusinessMapCompany` 合约：`tree` 字段扩成 `features: Record<Feature, {generate: boolean; display: boolean; published: boolean; publishedAt: string | null}>`；列表接口一次读出四个功能的发布状态（`sec_cache` 前缀各查一次，次数不随公司数增长）。

### 页面

列：公司 ｜ 状态 ｜ 财报摘要 ｜ 要点 ｜ 业务解读 ｜ 业务脑图 ｜ 操作。

- 「状态」只保留财务地图徽章（已显示 / 准备中 / 未就绪），去掉「AI 分析已加入 / 未加入」。
- 每个功能列：三档分段控件（关 / 生成 / 显示，沿用后台的药丸分段样式），下方小字是发布状态：「未生成」「已生成 · 10-15」「准备中」。生成中的状态从现有 AI 运行表读最近一次运行。
- 表头每个功能列标题旁放全局开关（替代今天工具栏里的「业务脑图生成」）；全局关闭时该列控件变灰并在列顶显示「已全局暂停」。
- 公司不在白名单：四列控件禁用；加入后恢复为存储值。
- 操作列不变：重新准备、财报、地图、移出 / 加入。
- 提示语按现有口径：`{ticker} 要点已显示` / `已生成` / `已关闭`；拒绝时 `先开启财报摘要`。

接口：`POST /admin/business-map/companies/:ticker/features/:feature`（body `{generate?, display?}`，只改给定的位），`POST /admin/business-map/features/:feature`（全局 `{generate}`）。原 `/ai`、`/tree`、`/tree` 全局三个接口在 admin 代理白名单里换成这两个。

### 实施顺序与验证

1. 迁移 `0030_business_feature_settings.sql`（建表、回填）；`company-policy.ts` 解析四个名单，`trackedTickersFor`/`treeTickersFor` 改读新字段；现有测试 `company-policy.test.ts` 扩成四个功能。
2. registry scope 拆分、`feature.settings` 事件、router；`check:pipeline:boundary` 与 registry 测试通过。
3. 读取侧隐藏：`filings`、`guidance`、`findings`、`business-explainer`、`findings-index`；读取测试补隐藏用例。
4. 后台接口与页面、admin 代理白名单；`admin:typecheck`、`admin:build`。
5. 文档：`docs/businessview-admin.md` 的白名单段、`docs/business-tree.md` 的开关段、`docs/pipeline-events.md` 的事件表。
6. 上线后在后台把一家公司的要点切到「生成」，核对公司页与首页不再列出它、后台仍能看到；再切回「显示」，核对版本号前进、页面即时恢复。

### 实施记录（2026-10-17）

与方案的差异：

- 名单解析放在 `FEATURE_RESOLVED`（JSON，含四个名单与四个全局开关）；`SEC_AI_TICKERS`、`SEC_AI_ENABLED` 设为财报摘要的名单与全局开关，`BUSINESS_TREE_ENABLED` 设为业务脑图的，读这些变量的旧代码（报告 Workflow 的 `trackedTickersFor`、`aiIsEnabled`、后台「财报与更新记录」的分析入口）含义不变。
- 要点的 `feature.settings` 同时排 `findings` 与 `company-analysis`：要点的输入之一是公司分析，开启要点时先补上缺的分析。记忆 Workflow（`memory-workflow.ts`）按要点名单认领任务，财报摘要开着但要点关着的公司不再花公司分析的模型费用。
- 财报摘要切到「关」时后台直接把要点也切到「关」（方案里的两个选项取了前者）；开启要点时若财报摘要没开则拒绝。
- 后台每列小字只显示「未生成 / 已生成 · 日期 / 已停止生成 / 已全局暂停」，没有「准备中」：运行状态在「公司要点」「公司业务板块」页各自可见。
- 旧接口 `/ai`、`/tree`、全局 `/tree` 已删除，admin 代理白名单换成 `/features/:feature`。

### 不做的事

- 不给财务地图单独加显示开关：移出白名单已经是它的「关」。
- 不把翻译、同业、文件库做成功能开关：它们没有读者可见的独立入口，跟随白名单。
- 不改 `SEC_AI_TICKERS` 等部署变量的名字，只改它们的解释范围。
