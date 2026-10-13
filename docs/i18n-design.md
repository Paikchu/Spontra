# ADR-i18n: 业务地图的国际化（首个目标语言：中文）

**Status:** 本期（前端）已实现 2026-10-13，未发布；下期（后端译文）待做
**Date:** 2026-10-13
**Deciders:** Max

## Context

业务地图（`apps/business-site`）是一个 Vite + React 19 的单页应用，约 3,200 行 TSX，`<html lang="en">`，没有任何 i18n 基础设施。页面上的文字分两类，来源和体量完全不同：

| 文字层 | 来源 | 体量 | 现状 |
|---|---|---|---|
| **UI 骨架**：导航、标签、空状态、按钮、单位、图表轴 | 前端源码里的字面量 | 约 150 条短字符串 | 全部英文硬编码 |
| **分析内容**：findings 的 label/detail/narrative、报告 headline/bullets/analystView、业务树节点名、filing 索引卡、业绩指引句子、lens 文档 | Pipeline Worker 的 Agent 生成，评审后写入 D1（`sec_cache` 的 `findings:v2:`、`business-tree:v1:`、`library-cards:v1:` 等键） | 一家公司一个季度几千到上万字 | 所有 prompt 明确要求 "write in English"；读路由只做 D1 查询 |
| **数字与日期** | 前端格式化（`Intl.NumberFormat("en-US")`、`$1.2B`、`3.4M shares`） | 遍布 model 层 | 英文计数习惯（K/M/B） |

约束（来自仓库规则与既有决定）：

- 前端不写任何人声旁白（docs: "Frontend has no narration"）；i18n 只翻译标签，不新增解说文案。
- 读路由只做 D1 查询，数据在 ingest 时准备好（"SEC data prepared before read"）。任何需要模型参与的事都必须在写路径完成。
- 除 SEC 发现之外不用 Cron，一切任务由 events/tasks 队列驱动。
- Agent 是**公用**的：同一家公司的分析对所有访客相同，不存在"每个用户一份"。这决定了多语言内容是"生成一次、翻译一次、全员共享"的发布产物，而不是按请求生成。
- 本期范围：先只做前端中文，不动后端。

业界参考（公开资料有限，均为二手或产品自述）：Vitals 这类产品先用主语言生成摘要、再按 locale 翻译；Chat2Report 把输出语言交给请求方选择；M-Brain 只保留英文摘要、不做本地化；Google Finance 欧洲版声称 AI 功能支持本地语言但未说明是原生生成还是事后翻译；TradingView 界面多语言但内容逐篇处理、很多内容只有英文。没有找到 Simply Wall St / TradingView 翻译 AI 内容的公开说明。结论：**"英文生成 + 事后翻译"是主流且稳妥的做法；"按语言分别生成"少见。**

## Decision

分两层、两阶段：

1. **UI 骨架（本期）**：前端自建类型化字典（`en` / `zh-CN`），`t()` 取值；数字、日期、货币走按 locale 的格式化器（中文用 万/亿）。语言由 `?lang=` → `localStorage` → `navigator.language` 决定，同步到 `<html lang>`。
2. **分析内容（下期，需要后端）**：保持英文为唯一"生成与评审"语言；发布后由队列事件触发一次**结构化翻译**（只翻译 schema 里标记为 reader-facing 的字符串字段，带金融术语表），按内容哈希缓存到 D1 的 `…:zh-CN` 键；读 API 按 `lang` 参数返回译文，字段级回退到英文。**不**按语言分别运行 Agent，**不**在读路径调模型，**不**让浏览器实时翻译。

本期上线后的状态是明确的：中文界面 + 英文分析正文。这是诚实的中间态，比机翻正文更可信。

## Options Considered

### A. UI 骨架：i18n 库选型

| 方案 | 复杂度 | 依赖 | 类型安全 | 适用性 |
|---|---|---|---|---|
| **A1 自建类型化字典**（推荐） | 低 | 0 | 键缺失即编译错 | 150 条、无复数/性别、SPA，足够 |
| A2 react-i18next | 中 | +2 包，运行时解析 | 需额外声明 | 功能过剩；运行时插值、命名空间对本项目无用 |
| A3 Lingui / Paraglide | 中 | 编译期提取 | 好 | 有编译步骤与提取 CLI，字符串规模不值得 |

A1 的具体形态：`apps/business-site/src/i18n/{en.ts,zh-CN.ts,index.ts}`，`const dict = { allBusinesses: "All businesses", … } satisfies Dictionary`，`zh-CN` 类型为 `typeof en`，缺键无法通过 `typecheck`。当字符串超过约 500 条或出现复数规则时再迁移到 A3。

### B. 数字 / 单位本地化

| 方案 | 说明 |
|---|---|
| **B1 locale-aware 格式化器**（推荐） | 把 `events-model.ts`、`guidance-marks.ts`、`packages/web/src/model/*` 中散落的 `toFixed(2)+"B"` 收口到一个 `formatMoney(value, {locale, currency})` / `formatShares` / `formatPeriod`。en：`$1.2B`；zh-CN：`12.0亿美元`、`340万股`、`2025年第三季度`。 |
| B2 只翻标签，数字沿用 K/M/B | 中文读者看 `$1.2B` 需换算；财务站点不可接受 |

注意 `Intl.NumberFormat("zh-CN", {notation:"compact"})` 会输出 "12亿" 但对 "万" 的阈值和小数处理不稳定，建议自写 万/亿 分档，Intl 只负责千分位与小数。

### C. 分析内容的多语言策略

| 方案 | 生成成本 | 一致性 / 可信度 | 扩展到第 N 种语言 | 与仓库规则 |
|---|---|---|---|---|
| C1 **按语言分别运行 Agent**（prompt 加 language 参数） | N × 推理成本（含 ReAct 搜索、evidence-review） | 差：各语言版本事实可能不一致；非英语推理质量下降；evidence-review 需按语言再跑 | 线性增长 | 符合 |
| C2 **一次生成双语 JSON**（同一次输出 en+zh 字段） | 1 × 推理 + 约 2× 输出 token | 中：同次输出事实一致，但翻译质量受推理模型限制 | 新增语言要重跑全部生成 | 符合 |
| **C3 英文生成 → 发布后结构化翻译**（推荐） | 1 × 推理 + 每语言 1 次低成本翻译调用 | 好：英文版是唯一评审对象，译文是它的派生物；术语表保证一致 | 加一个 locale = 加一个翻译任务 | 符合：队列事件、写路径准备、读路径只查表 |
| C4 读请求时翻译（Worker 调模型） | 每次未命中都付费 | 好 | 容易 | **违反**"读路由只做 D1 查询" |
| C5 浏览器机翻（Chrome Translator API / Google 小组件） | 0 | 差：财务术语错译、SVG 图表标签不翻、布局抖动 | 免费 | 符合但产品不可控；可作个人临时手段，不作产品方案 |

C3 细节：

- **触发**：现有发布流程末尾（findings/business-tree/explainer/library-cards/guidance/lens 写入 `sec_cache` 之后）投递 `publication.translate {kind, ticker, periodEnd, locale}` 事件；`locales` 配置在 `ai-config.ts`。
- **字段白名单**：每个 `shared/analysis-contract/*` 类型旁边声明 `readerFacing: ["label","detail","narrative","headline","bullets[].label", …]`，翻译器只走白名单，id、sourceIds、数字、periodEnd、ticker 原样复制。这样译文结构与英文完全同构，前端零改动。
- **缓存键**：`findings:v2:${ticker}:${periodEnd}:zh-CN`，payload 内记 `sourceSha256`；英文重发布时哈希变化才重译。
- **术语表**：`workers/pipeline/src/i18n/glossary.zh-CN.ts`，Revenue→营业收入、Operating income→营业利润、Guidance→业绩指引、Segment→业务分部、Basis→口径……随 prompt 一起送入；分部名（来自 SEC MetaLinks 的英文标签）译文后保留英文原名，如 "智能云 Intelligent Cloud"。
- **读 API**：`GET /api/business/v1/companies/:ticker/findings?lang=zh-CN`；命中返回译文并带 `contentLanguage: "zh-CN"`，未命中返回英文并带 `contentLanguage: "en"`，前端据此在正文角落标注 "English"（这是一个标签，不是旁白）。
- **模型**：低推理档（与 index cards 同档），一次翻译整份 JSON；超长 narrative 按段落分块。

## Trade-off Analysis

- **为什么不在 Agent 上"做文章"（C1/C2）**：Agent 是公用的，内容对所有人一样，所以语言不是用户维度而是发布维度。按语言重跑把最贵的那一步（ReAct + 搜索 + 评审）乘以 N，并且制造"两份事实"。翻译一份已评审的英文版，成本是零头，而且可信度可追溯到同一份证据。若将来变成个人 Agent（按用户问题生成），才值得把语言放进生成 prompt。
- **为什么不把中文正文放进本期**：它必然碰后端（写路径、D1 键、读 API），与用户"先不动后端"的边界冲突；而 UI + 数字层独立可交付。
- **A1 自建 vs 库**：150 条字符串下，库的运行时体积和学习成本都大于收益；类型化字典让缺译在 `typecheck` 就暴露，比库的运行时 fallback 更符合"没有旁白、没有半成品"的产品要求。
- **URL 策略**：SPA 无 SSR，暂不做 `/zh/` 路径前缀与 hreflang；`?lang=` 可分享，`localStorage` 记住偏好。若未来做 SSR/SEO，再升级为路径前缀。

## Consequences

- 变容易：新增语言 = 新增一个字典文件 + 一个术语表 + 配置里加一个 locale。
- 变容易：译文与英文同构，前端组件不感知语言差异；图表（Sankey、脑图、lens iframe）的文字来自同一份数据。
- 变难：所有新 UI 文案必须进字典，需要一条 ESLint 规则（JSX 中禁止裸英文字面量）守住。
- 变难：模型层散落的 `toFixed` 格式化要先收口，才能做 locale 分支；这是本期最大的重构面。
- 需要回访：lens agent 生成的文档是否走同一套 `sec_cache` 发布路径；若是即时生成，需把翻译挂在它的缓存写入之后。
- 需要回访：中文下的字体与行高（CJK 已有 `@streamdown/cjk`，但 `style.css` 的字号/字距是按英文定的）。

## Action Items

本期（前端）：实际落点与本节最初设想不同处：字典按文件就近定义（`messages(en, zh)`，见 [i18n-conventions.md](i18n-conventions.md)），核心在 `packages/web/src/i18n/`，数字形式在 `shared/analysis-runtime/locale.ts`；lens 编译器已接受 `locale`，图中由编译器产生的文字已本地化。


1. [x] `apps/business-site/src/i18n/`：`en.ts`、`zh-CN.ts`、`index.ts`（`useLocale()`、`t()`、locale 解析 `?lang` → `localStorage` → `navigator.language`，写回 `<html lang>`）。
2. [x] 把约 150 条 JSX/模板字面量替换为 `t("…")`；`index.html` 的 `<title>`/`description` 改由运行时设置。
3. [x] 收口数字格式化：`packages/web/src/model/format.ts` 提供 `formatMoney/formatShares/formatPercent/formatPeriod(locale)`，替换 `events-model.ts`、`guidance-marks.ts`、`fundamental-chart.ts`、`business-flow-model.ts` 中的内联格式化；中文走 万/亿。
4. [x] 侧栏加语言切换（两项：English / 中文），切换只改状态，不刷新。
5. [x] ESLint：JSX 文本节点禁止裸字母字符串（白名单 ticker、单位符号）。
6. [x] 正文区域（findings、报告、业务树）显示内容语言标签（本期恒为 "English"），为下期译文到位做好位置。
7. [x] 验证：`npm run check:i18n` 离线检查文案表、中文字面量、数字形式与渲染页面，并纳入 `npm run build`；用 fixture 离线预览核对过公司页、要点、事件与财报面板的中文版面。真实数据下的版面在上线后再看一次。

下期（后端，另开 ADR 执行）：

8. [ ] `ai-config.ts` 增 `locales`；发布流程末尾投递 `publication.translate` 事件。
9. [ ] `shared/analysis-contract` 各类型声明 reader-facing 字段白名单；实现结构化翻译器 + `glossary.zh-CN.ts`。
10. [ ] `sec_cache` 译文键与 `sourceSha256`；读 API `lang` 参数与字段级回退。
11. [ ] 前端 `fetchCompany/fetchSupplement` 带上 locale，内容语言标签改为读响应的 `contentLanguage`。

## 延伸：AI 即时生成的文本与图片

判断准则只有一条：**这份内容是发布一次、全员共享，还是按请求生成、按请求付费。** 前者的语言是发布维度（英文生成 → 派生译文，见 C3）；后者的语言是请求维度（locale 进 prompt，原生生成）。

### 即时生成文本（对话式回答、按焦点生成的 lens 文档、流式输出）

- 事后翻译不可行：流式输出没有"发布后"这一步，而且每次生成的输入不同，没有可共享的英文母本。
- 因此 `locale` 作为请求参数进入 prompt。写法固定为"用英文推理、用 {locale} 作答"：推理与工具调用（搜索词、SEC 读取、证据核对）保持英文，只有最终 reader-facing 字段按 locale 输出。这保住了英文推理质量，也保证 sourceIds、数字、periodEnd 等结构字段与语言无关。
- 术语表复用 `glossary.{locale}.ts`，与 C3 用同一份，避免发布正文与即时回答对同一概念叫法不同。
- 缓存键必须带 locale：`lens:v1:${inputSha256}:${locale}`。同一输入第二个访客命中缓存，公用 Agent 仍然是"一份内容服务所有人"，只是按语言各一份。
- 结构化输出的 schema 不随语言变化；前端继续不感知语言，只读响应里的 `contentLanguage`。

### 生成图片

图片的问题只在于**烙进像素里的文字**。拆成三类处理：

| 类型 | 做法 |
|---|---|
| 数据图表、示意图（Sankey、脑图、lens 中的图） | 不生成图片，生成**规格**（已有的 lens grammar）+ 数据，由客户端渲染。规格里的标题、轴名、标注都是字符串字段，走白名单翻译；数字走 locale 格式化。这是现有架构，保持。 |
| AI 绘制的插图、封面、示意画面 | 图片本身做成**语言中立资产**：prompt 明确 "no text, no labels, no numbers"，产出一次，所有语言共用；需要的说明文字用 HTML/SVG 叠加层放在图片之上，叠加层的字符串走字典或翻译。alt 文本与图注是普通文本字段，同样走翻译。 |
| 文字不可避免的图片（带标注的截图式画面） | 按 locale 分别生成并存 `image:${hash}:${locale}`。成本 N 倍，且扩散模型对 CJK 文字渲染不可靠，只作例外，设计评审时应先问能否归入前两类。 |

共同点：每个 AI 产物都是一份 JSON 契约 `{ sourceLang, contentLanguage, sourceSha256, readerFacing: [...], assets: [{id, languageNeutral: boolean}] }`。文本字段可翻译，资产按 `languageNeutral` 决定是共享还是按语言各存一份。前端对三类内容的处理方式一致：读 `contentLanguage` 标注语言，其余不感知。

## iframe 里的图：文字从哪来，就在哪翻

前提先纠正：lens 的图**不是模型写的 HTML**。模型写的是声明式 `LensChart`（JSON：series 绑 ref、mark、annotation 模板、band），host 用 `compileLens` 编译成 `CompiledChart`（所有文字已经是最终字符串），经 postMessage 交给 `/lens-frame.html`，frame 只跑 `renderChartSvg` 画 SVG。CSP `script-src 'self'` 和 sandbox 保证模型没有任何通道把 HTML 或脚本送进页面。所以"图里的文字"只有两种来源，各自已有归宿：

| 来源 | 具体字段 | 现状 | 做法 |
|---|---|---|---|
| **模型写的词** | `chart.title`（≤60 字符）、`series.label`（≤40）、`annotation.text` 里 `{value}` `{change}` `{period}` 之外的词、`band.label`、`prose` 段落 | 存在 `findings:v2` 的 LensDocument 里 | 走发布后的白名单翻译（C3），与 findings 正文同一个任务；占位符原样保留；字数上限按字符计，中文更短，不会超 |
| **编译器生成的字** | `formatResolved`/`formatDelta`/`tickLabel`/`compactMoney`（`$46.9B`、`+118.0%`）、`periodLabel`（`FY to 2026.08`）、`" YoY"/" QoQ"` 后缀、`refLabel` 取自 ledger 的指标名（"Operating cash flow"）、`summary` 无障碍描述 | 全在 `shared/analysis-runtime/lens/format.ts` 与 `compile.ts`，硬编码英文 | `compileLens` 增加 `locale` 入参，`format.ts` 按 locale 分支（中文 万/亿、"FY 至 2026.08"、"同比"/"环比"）；指标名是有限枚举（FindingRef 的 metric key），放前端字典而不是让 AI 翻 |

两点后果：

1. **翻译后要再编译一次，不用模型。** harness 用来给 Lens Agent 看的 `compileLens` + `auditLayout` 是纯函数；翻译任务在写入 `…:zh-CN` 前以 `locale: "zh-CN"` 重跑一遍，拿到的 warnings（周期标签碰撞、图例超宽、图文失衡）就是中文版的真实版面。碰撞时自动改 `periodLabels: "sparse"`，仍不通过再把该图标记 `contentLanguage: "en"` 回退。`audit.ts` 的 `CHAR = 6.6` 是拉丁字母宽度，CJK 一字约一个 em，需要按 locale 换常量。
2. **`verifyNumbers` 要和 `format.ts` 同源。** 正文里的数字现在以 `$46.9B` 这种英文写法被校验；中文正文写成 `469亿美元` 后，校验器必须能用同一份 format 模块反向解析，否则要么校验失败、要么被迫在中文正文里保留英文数字写法。这是 phase 2 里唯一真正的新逻辑。

如果将来真的让模型直接产出 HTML/SVG（本架构不允许，列在这里只为封住问题）：规则是**结构与文字分离**，模型输出的标记里文字只能通过 `data-i18n="key"` 槽位或随附的 strings 表进入，翻译器只翻 strings 表；绝不翻译带内联数字的自由 HTML。

## Sources

- [Vitals: Multi-language AI reviews summary](https://vitals.app/changelog/multi-language-ai-reviews-summary)
- [Chat2Report changelog: AI-generated financial report summaries](https://ch2report.featurebase.app/en/changelog/added-ai-generated-financial-report-summaries)
- [M-Brain: AI-abstracted summaries in English](https://valonaintelligence.com/news/m-brain-provides-intelligence-plaza-customers-access-to-its-global-content-and-unique-ai-abstracted-summaries)
- [Google Finance with AI arrives in Europe](https://metodoviral.com/en/news/google-finance-with-ai-arrives-in-europe-with-advanced-features/)
- [Atlassian CONFCLOUD-79500: AI summaries no longer localized](https://jira.atlassian.com/browse/CONFCLOUD-79500)
- [Elfsight: generate the AI summary in the local language](https://community.elfsight.com/t/generate-the-ai-generated-summary-in-the-local-language/106515)
