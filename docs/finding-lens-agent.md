# ADR：要点 Lens Agent（要点页独占舞台、iframe 图表、harness 驱动）

**状态：** 已采纳，2026-10-13 实现 · **日期：** 2026-10-12 · **前置：** [statement-highlights](statement-highlights.md)、[findings-events-design](findings-events-design.md)、[business-tree](business-tree.md)（ReAct harness）

## 背景

要点（findings）聚焦时，舞台仍然画着亮点数字条、Sankey/资金池和时间轴，lens 只占底部 `clamp(236px, 34vh, 340px)` 的一条（`style.css` `.lens`）。图是三种写死的渲染器（`LensPanel.tsx` 的 `Bars`、`Shares`、`Ladder`），模型只能在 `trend | compare_bars | share_area | ladder` 四个枚举里选一个（`shared/analysis-contract/findings.ts` `FindingLens`）。要点的文字也只有一段 80–180 词的 judgment。

这带来三个问题：

1. 要点没有讲解空间：一条要点要在三分之一屏里同时放图、判断、证据表、watch 和来源。
2. 图表类型写死：每出现一种新的要点（RPO 阶梯、内幕交易、并购、新闻）都要在前端加一种渲染器和一个枚举，与"不 hard code、面向所有公司"的目标相反。
3. 模型对自己的图没有任何反馈：写完 `lens` 就结束，看不到图画出来是什么样、数据够不够、标签挤不挤、和文字搭不搭。

目标：要点聚焦时整张舞台交给要点；图和讲解版面由一个 Agent 在 harness 的约束和反馈下生成；图在 iframe 中渲染；任何公司、任何要点类型（财报、事件、未来的新闻）走同一条流程。

约束（沿用仓库既有原则，不新增例外）：

- 页面上的每个数字都来自已发布数据，模型不写数字（`findings.ts` 顶部注释，`verifyFindings`）。
- 读路由只做查找，模型只在 Spontra Analysis 内调用（[sec-data-prepared-before-read](sec-filing-library.md)）。
- 事件驱动，不加 Cron（[analysis-events](analysis-events.md)）。
- 前端不出现模板化的人类语气文字；AI 生成内容例外。
- 站点 CSP 为 `script-src 'self'`、`frame-ancestors 'none'`（`apps/business-site/public/_headers`、`worker/index.ts` `security`）：浏览器不执行任何内联或模型生成的脚本。

## 决策

**要点的 lens 从"一个枚举"变成"一份 Lens 文档"：由 Lens Agent 在 ReAct harness 里用一套通用图表语法（lens grammar）和版面语法写成；harness 用与前端完全相同的编译器把文档编译成可画的结果，把编译结果（数据解析、尺度、标签、版面审计）作为 observation 回给模型，直到模型 finish。前端舞台在要点聚焦时只渲染这份文档；图表由固定的、同源的 iframe 渲染器（`/lens-frame.html`）按 host 下发的编译结果绘制。模型从不产出可执行代码，也从不写数字。**

```
                      Spontra Analysis（FindingsWorkflow）                                  business-site
┌─────────────┐   ┌──────────────────────────────────────┐   ┌──────────────┐   ┌──────────────────────────┐
│ findings 写 │──▶│ Lens Agent（每条要点一个 ReAct 循环）   │──▶│ findings.v2  │──▶│ BusinessMap  stage[focus] │
│ 作 + 校验   │   │  model: think → action                 │   │ lens: 文档    │   │  ┌ LensDocument（grid）   │
└─────────────┘   │  harness: compile / audit / verify     │   └──────────────┘   │  │ prose │ chart(iframe) │ │
   ledger ───────▶│  observation ← compileLens(doc, data)  │                      │  │ figures             │ │
   data   ───────▶│            ← auditLayout(compiled)     │        同一份        │  │ chart(iframe)│ prose │ │
                  │            ← verifyNumbers(prose)      │ ◀──── shared/ ──────▶│  └ watch · sources      │ │
                  └──────────────────────────────────────┘   lens-grammar         └──────────────────────────┘
```

## 关键点一：harness 如何控制 iframe 里的图表

核心是**三处共用同一个纯函数编译器**：

```
shared/analysis-runtime/lens/
  compile.ts    compileLens(chart, data, viewport) → CompiledChart   解析每条 series 的每个值（resolveRef）、算尺度、生成每个标签的文字
  audit.ts      auditLayout(doc, compiledCharts, widthClasses) → Warning[]  标签碰撞、图文高度失衡、空格子、点数不足…
  describe.ts   describe(compiled) → string   给模型看的"渲染报告"，也作为页面的无障碍描述
  render-svg.ts renderSvg(compiled, theme) → SVG 字符串   不碰 DOM，iframe 与行内回退共用
```

1. **模型只写声明，不写代码。** `LensChart` 是声明式语法（见"合同"）：series 绑定 `FindingRef`，mark 绑定 series id，annotation 的文字是模板（`{value}`、`{change}`、`{period}`），由编译器从解析出的值格式化。模型没有任何通道把数字或脚本送进页面。
2. **harness 的 observation 就是前端将要画的东西。** 模型每轮提交整份文档，harness 调 `compileLens` + `auditLayout` + `verifyNumbers`，把结果用 `describe` 写成文字回给模型（示例见下）。因为前端 `LensFrame` 组件调用的是同一个 `compileLens`，模型在 harness 里看到的尺度、点数、标签和审计结论，就是用户看到的图。没有"Spontra Analysis 里通过、页面上画坏"的缝隙。
3. **iframe 只是画笔。** host（BusinessMap）持有 `FindingData`，在读时编译，把 `CompiledChart`（纯 JSON，值已解析、标签已格式化）连同主题 token 和尺寸经 `postMessage` 发给 `/lens-frame.html`；frame 里只有 `renderSvg`，不含解析器、不含任何数据获取。frame 用 `sandbox="allow-scripts"`（不给 `allow-same-origin`，起源为 opaque），只能通过 postMessage 回话。
4. **harness 的硬约束在语法层而不是提示词层。** 可用的 ref 来自 ledger（模型拿到的 catalogue 就是 `buildLedger` 的行），mark 类型、颜色只能用 token 名（`profit`、`expense`、`revenue`、`biz-n`、`loss`、`up`），周期数、series 数、图表数都有上限（`LENS_LIMITS`）。不合法的文档在 `readLensDocument`（zod）就被拒绝，observation 指出哪一项违规。

一次 observation 的样子（`describe` 的输出，纯文本）：

```
chart c1 (bar, wide): 3 series × 2 periods (fiscal_year), periods FY to 2025.08, FY to 2026.08
  s1 Operating cash flow  USD  $21.5B → $46.9B  (yoy +118.0%)
  s2 Capex                USD  $27.4B → $75.7B  (yoy +176.0%)
  s3 Free cash flow       USD  −$5.9B → −$28.7B  (negative both periods; zero line drawn)
  y domain −$28.7B … $75.7B; 2 period labels, no collision at any width class
  annotation a1 at s2/2026-08-31 → "$75.7B"; a2 at s3/2026-08-31 → "−$28.7B"
row 1 [chart c1 | prose p1]: medium/wide balanced (chart 310px, text ≈ 290px); narrow stacks
row 2 [figures]: 4 rows, all resolved
prose p1: 142 words; numbers 75.7, 176.0, 46.9, 118.0, 28.7 all supported by cited evidence
warnings: none
```

模型据此决定：换 series、改 span、加一张图、把并排改成上下、删掉撑不起来的注释，或 finish。

## 关键点二：图表如何与整页报告排版融为一体

iframe 最容易出的问题是"一个固定尺寸的盒子"：内部滚动条、底部留白、字体和配色跟页面不一致、主题切换不跟随、首帧闪白。方案把**尺寸、主题、时序三件事全部交给 host**，frame 不做任何自主布局：

1. **尺寸由 host 的 CSS 网格决定，frame 永远填满。** Lens 文档渲染为 `.lens-doc`（CSS grid，行 = 文档的 row，格子 = block）。图表格子的高度用容器查询算出：`height: clamp(var(--chart-min), calc(100cqw * var(--aspect)), min(var(--chart-max), 52vh))`，`--aspect` 来自图表声明的 `aspect`（`wide` 0.42 / `square` 0.8 / `tall` 1.1，常量在 grammar 里）。iframe `width:100%; height:100%; display:block; border:0`，frame 内 `overflow:hidden`，SVG `viewBox` 取 host 发来的像素尺寸，`preserveAspectRatio="none"` 不用，坐标按真实像素算，因此文字不会被拉伸。host 用 `ResizeObserver` 把尺寸变化（拖窗、收起 rail）发给 frame，frame 重画。frame 不向 host 报高度，不会出现"frame 自己长高把版面撑开"。
2. **图文不失衡由 harness 的审计保证，而不是 CSS 兜底。** `auditLayout` 在三个宽度档（narrow ≤ 720、medium、wide ≥ 1200）估算每个格子的高度：图 = 宽 × aspect；文字 = 字数 / 每行字数 × 行高（用 13px/1.65 的真实样式常量）。同一行里两个格子高度差超过 35% 发 `imbalance` 警告，模型要么换 aspect、要么把并排改成上下、要么把文字拆到下一行。空格子、`chart|chart` 却只有一张图、周期标签宽度总和超过绘图宽度（碰撞）、series 少于 2 个点、图例超宽，都是审计项。这些规则对任何公司、任何图都一样。
3. **主题与字体与页面同源。** host 读取 `:root` 上的设计 token（`--foreground`、`--muted-foreground`、`--hairline`、`--border`、`--flow-*`、`--biz-*`、`--loss`、`--up`、`font-family`）和当前 scheme（`.light`），随 `lens:render` 发给 frame，frame 写到自己的 `:root` 并加载同一份字体文件（同源，缓存共享）。frame `body` 背景透明（`allowtransparency`），页面的点阵纸底透过来，图和周围文字看起来在同一张纸上。主题切换时 host 发 `lens:theme`，frame 只改变量不重编译。
4. **首帧与动效。** 格子先以正确高度占位（高度来自 CSS，不等 frame），frame 收到 `lens:render` 画完回 `lens:rendered`，host 再把格子 `opacity` 从 0 过渡到 1；lens 整体仍用现有的 `rise` 动画。frame 1.5 秒内没有 ready，host 用同一个 `renderSvg` 行内画出来（同样的图），iframe 是隔离手段而非依赖。
5. **交互联动。** frame 发 `lens:hover {period}`，host 把 figures 块里同周期的行高亮；host 发 `lens:focus {period}`（用户点证据行）frame 高亮该列。这样图和表是一体的，而不是并排的两个东西。
6. **CSP。** `_headers` 对 `/lens-frame.html` 单独覆盖 `frame-ancestors 'self'`（其余路径保持 `'none'`）；frame 文档自身的脚本来自同源 bundle，`script-src 'self'` 不变。opaque origin 下 `'self'` 按文档 URL 匹配，仍然成立；实施时在本地 wrangler 环境核验。

## 合同

`shared/analysis-contract/lens.ts`，发布物 `findings.v2`（`FindingsPublication.schemaVersion`），`AnalysisFinding.lens` 允许 `{ type: "document"; document: LensDocument }`；旧的四种枚举保留读取能力，由 `legacyLens.ts` 确定性转换成 `LensDocument`，前端不再有专用渲染器。

```ts
export type LensDocument = { rows: LensRow[] };
/** 一行一或两格；两格时 narrow 自动上下堆叠。 */
export type LensRow = { cells: [LensBlock] | [LensBlock, LensBlock] };
export type LensBlock =
  | { kind: "prose"; paragraphs: ExplainerClaim[] }          // 每段 ≤ 1,400 字符；数字须被引用的 evidence 支持
  | { kind: "chart"; chart: LensChart }
  | { kind: "figures"; refs: FindingEvidence[] }             // 证据表，读时解析
  | { kind: "watch" }                                        // 画 finding.watch
  | { kind: "sources" };

export type LensChart = {
  id: string;
  title?: string;                                            // ≤ 60 字符，无数字
  aspect: "wide" | "square" | "tall";
  series: LensSeries[];                                      // 1–6
  marks: LensMark[];                                         // 1–6
  annotations?: LensAnnotation[];                            // ≤ 6
  axis?: { periodLabels?: "all" | "sparse"; zeroLine?: boolean; unit?: "auto" | "percent" | "ratio" };
  legend?: "top" | "none";
};
export type LensSeries = {
  id: string;
  ref: FindingRef;                                           // 只能是 ledger 里出现的 ref
  span: FindingSpan;
  periods: number;                                           // 1–12，以要点的 periodEnd 结束
  transform?: "value" | "yoy" | "qoq" | { shareOf: FindingRef }; // 由编译器计算，不是模型
};
export type LensMark = { type: "bar" | "line" | "area" | "step" | "dot" | "stacked_bar" | "stacked_area" | "waterfall" | "rule"; series: string[]; color?: LensColorToken };
export type LensAnnotation =
  | { at: { series: string; period: "latest" | "first" | string }; text: string }  // text 只允许 {value} {change} {period} {label} 模板和不含数字的词
  | { type: "band"; from: string; to: string; label?: string };                    // 周期区间
export type LensColorToken = "revenue" | "profit" | "expense" | "loss" | "up" | `biz-${0|1|2|3|4}` | "muted";
```

限制常量 `LENS_LIMITS`（rows ≤ 6、charts ≤ 3、series ≤ 6、periods ≤ 12、annotations ≤ 6、prose 段 ≤ 1,400 字符）放在合同，harness 与前端同用。

读时校验 `verifyLensDocument(doc, finding, data)`（`shared/analysis-runtime/lens/verify.ts`，Spontra Analysis 与页面同一函数）：

- 每条 series 的 ref 在 `data` 可解析（复用 `resolveRef`），至少 2 个周期有值；否则该图整张撤下，所在行的另一格占满整行。
- prose 的数字用现有 `proseNumbers` / `numberSupported` 对照该要点 evidence 的 `evidenceCandidates`；不支持的段落撤下。
- annotation 的 `text` 去掉模板占位符后不得含数字（`plainText`）。
- 图全撤或行全撤时退到 `documentFromEvidence(finding)`：一行 `chart|prose`，图是 evidence refs 的 bar；这是唯一的确定性兜底，对任何要点都适用，因此不存在 hard code 的案例分支。

## Agent 流程（Spontra Analysis）

位置 `workers/analysis/src/lens/`，形式与 `business-tree/agent.ts` 相同（think → action → observation，durable steps）。

```
输入（LensSubject）             harness 动作                       observation
├ finding（title/judgment/      compile {document}   ──▶  readLensDocument(zod) → compileLens → auditLayout
│   evidence/kind/watch）                                    → verifyNumbers → describe()
├ catalogue：ledger rows        read {source, focus} ──▶  filing library 的原文段（复用 TreeLibrary；可关）
│   （ref/label/unit/各期值）    finish               ──▶  最近一次 compile 无 error 才接受，否则退回原因
└ budget：turns 6
```

- **subject 抽象**不绑定财报：`{ id, kind, title, judgment, evidence: FindingEvidence[], watch?, domain: "statement" | "event" | "news" }`。今天由 findings workflow 构造；事件要点（[findings-events-design](findings-events-design.md) 的 `event-findings.v1`）和将来的新闻要点构造同样的 subject，走同一个 agent。
- **catalogue 抽象**就是 ref 的集合加各期值。财报 = `buildLedger` 的行；事件 = 规划中的 `{ event, field }` ref；新闻 = 新闻条目的 ref（例如 `{ news: id, field: "mentions" | "sentiment" }`）。grammar 对 ref 类型无感知，只要 `resolveRef` 能解析。
- **系统提示只讲方法，不讲案例**：先决定这条要点"该让读者看见什么对比"（水平、变化、构成、路径、落点），再选 series 和 mark；优先少而清楚；每张图必须对应 judgment 里的一个句子；把 observation 里的 warning 清零再 finish。提示词不提任何公司、科目或行业。
- 模型推理档：`AI_TOOL_REASONING` 加 `lens: "low"`（observation 已经把计算做完，模型只做选择）；每轮 `maxTokens` 小；6 条要点并行，`Promise.allSettled`，单条失败保留 writer 给的旧 lens（经 `legacyLens` 转换）。
- **阶段位置**：`executeFindingsWorkflow` 在 `writeFindings` 校验之后、`writeHighlights` 之前增加 `findings-lens-<id>-t<n>` 步骤；`FINDINGS_VERSION` 升 v9 并把 `LENS_VERSION` 写进指纹。不新增 task、队列或 Workflow 绑定（理由与 statement-highlights ADR 选 C 相同：输入相同、触发相同）。
- **对话形式（2026-10-18，`lens.agent.v2`）**：与业务脑图 v10、分析师 v5 相同（见 [business-tree](business-tree.md) → 对话形式）。`compile {document}`、`finish {document?}` 是 Claude 客户端工具（文档语法超出 strict schema 上限，不设 strict，由 harness 校验）；不要求写出 thought；开头一条 user 消息携带 subject、evidence、catalogue、starting 和预算，之后每次回复原样回传、每个调用的结果作为 `tool_result` 跟在后面，对话只追加。拿不到可用回复的一轮不进对话、下一轮重发，连续 3 次保留 writer 的图；模型轮步骤名 `findings-lens-<id>-t<n>-act`。
- **轨迹**：每条要点的 turns（thought/action/input/observation 截断）存 `sec_cache` 键 `findings-lens-trace:v1:<ticker>`，不进公开发布物；Admin「公司要点」页在版本下展开"Lens 生成过程"，与业务脑图的 research steps 同一组件。

## 前端

`apps/business-site`：

- `BusinessMap.tsx`：`focused` 存在时舞台进入 `data-focus="finding"`：不渲染 `stage-head`（亮点数字条、YoY/QoQ 与视图切换）、`.chart`（Sankey/资金池）、`Timeline` 和 `stage-foot` 图例；只渲染 `<LensStage>`（原 `lens-stage` + `LensPanel` 的头部）。`.stage[data-focus="finding"] { grid-template-rows: auto minmax(0, 1fr); }`。关闭或切到报告/事件聚焦时恢复原舞台（Sankey 以 `revealKey` 重新进场）。对照模式（`split`）变为两份文档左右各一列，每列独立滚动。
- `LensDocument.tsx`：按 `rows` 渲染 grid；`prose` 用现有 `.lens-judgment` 样式 + 来源角标；`figures` 复用 `Evidence`；`watch`、`sources` 复用现有块；`chart` 交给 `LensFrame`。
- `LensFrame.tsx`：`compileLens` → `<iframe src="/lens-frame.html" sandbox="allow-scripts" title={chart.title}>` + postMessage 协议 + 行内回退 + 隐藏的 `describe()` 文本供读屏。
- `lens-frame.html` + `src/lens-frame/main.ts`：Vite 第二入口（`build.rollupOptions.input`），只含 `renderSvg` 和消息处理，不引入 React。
- `LensPanel.tsx` 的 `Bars/Shares/Ladder` 与 `findings-model.ts` 的 `lensColumns/lensShares/lensLadder` 删除，功能由 grammar 表达（RPO 阶梯 = `{capital:"rpo"}` 的 bar + 各桶 ref 的 `stacked_bar`；见实施项的 ref 扩展）。

postMessage 协议（`shared/analysis-contract/lens-frame.ts`，双方同一份类型）：

| 方向 | 消息 | 内容 |
|---|---|---|
| frame → host | `lens:ready` | — |
| host → frame | `lens:render` | `{ id, compiled: CompiledChart, size: { w, h }, theme: { tokens, scheme } }` |
| frame → host | `lens:rendered` | `{ id }` |
| host → frame | `lens:size` / `lens:theme` / `lens:focus` | 尺寸 / token / 高亮周期 |
| frame → host | `lens:hover` | `{ id, period \| null }` |

host 只接受 `event.source === iframe.contentWindow` 的消息；frame 只接受 `event.source === window.parent` 的消息。

## 备选方案

### A：模型直接写 HTML/JS，放进 sandbox iframe 渲染

| 维度 | 评估 |
|---|---|
| 表达力 | 最高 |
| 数字原则 | 破：模型代码里必然有数值；Spontra Analysis 无法执行它（Workers 不能 `eval`），也就无法校验它会显示什么 |
| CSP | 需开 `unsafe-inline` 或把模型代码作为同源资源分发，等于把模型输出当脚本发布 |
| 视觉一致 | 差：每条要点一套样式 |

未采纳。

### B：保留枚举 lens，只做"舞台让位 + iframe"

复杂度最低，但新要点类型仍要加枚举和渲染器，与通用目标矛盾；iframe 里包的还是写死的三张图，没有收益。未采纳。

### C：声明式 grammar + 共享编译器 + ReAct harness（采纳）

| 维度 | 评估 |
|---|---|
| 表达力 | 覆盖对比、趋势、构成、路径（瀑布）、落点（rule/band）；事件和新闻用 rule/band 标在时间轴上 |
| 数字原则 | 保持：模型只写 ref 与模板 |
| 复杂度 | 中：合同、编译/审计/描述/渲染四个纯模块、agent、frame 入口、舞台改造 |
| 成本 | 每条要点 ≤ 6 次低推理小调用 |

### D：grammar 但无 agent（writer 一次写出文档）

省调用，但模型看不到图画出来的样子，版面失衡和标签碰撞只能靠读时丢弃，这正是现状的问题。未采纳；作为 agent 失败时的退路（`documentFromEvidence`）。

## 权衡

- iframe 不是为了执行模型代码，而是为了把渲染器、样式和将来更重的图形依赖隔离在独立 bundle 里，并且让图表失败不影响地图；行内回退保证 iframe 不是单点。
- 用 CSS 容器查询定高度而不是 frame 回报高度：少一次往返、无闪动、无"frame 撑开版面"；代价是图的高度只能是 aspect 的函数，模型通过 `aspect` 和行布局表达意图。
- 审计是估算（字数、像素常量），不是真实排版；它防的是明显失衡与碰撞，细微差异由 CSS 吸收。阈值集中在 `audit.ts` 常量里。
- 旧发布物经 `legacyLens` 转换继续可用，不需要立刻重跑；AI 名单目前只有 ORCL，版本号升级后自动重写一次。

## 后果

- 更容易：新的要点来源（事件、新闻）只需提供 subject 与可解析的 ref，不改前端；新的图形只是 grammar 加一种 mark，三处（编译、描述、渲染）同步实现。
- 更困难：grammar 是一个要维护的小语言；`describe` 的文字质量直接影响模型决策，要配测试样例。
- 需要回看：上线后统计每条要点的 turns 数、warning 清零率、读时撤图率；若 `imbalance` 规则误报多，调常量而不是调提示词。

## 实施项

1. [x] 合同：`shared/analysis-contract/lens.ts`、`lens-frame.ts`；`AnalysisFinding.lens` 的 `document` 分支（schemaVersion 仍为 `findings.v1`，联合类型向后兼容，不改版本号）；`FindingBaseRef` 增加 `{ rpoBucket: n }`
2. [x] 共享运行时：`shared/analysis-runtime/lens/{schema,format,compile,audit,describe,render,verify,legacy}.ts`；`workers/analysis/test/lens.test.ts`
3. [x] Spontra Analysis：`workers/analysis/src/lens/agent.ts`（ReAct，budget 6，动作 compile/finish；`read` 留待接入文件库）；`ai-config.ts` 的 `lens: "low"`；`findings/workflow.ts` 在 findings 校验后、亮点之前运行，轨迹以 `lensTrace` 字段与发布物存在同一条 `sec_cache` 记录里（公开读取经契约剥离）；`FINDINGS_VERSION` v9 + `LENS_VERSION` 进指纹
4. [x] 站点：`_headers` 为 `/lens-frame`（静态资源把 `.html` 重定向到无后缀路径）覆盖 `frame-ancestors 'self'`；Vite 第二入口 `lens-frame.html`；`LensFrame.tsx`、`LensPanel.tsx`（文档渲染）、`lens-frame/{main.ts,hover.ts,frame.css}`；`BusinessMap.tsx` 聚焦态只渲染 lens；`style.css` 的 `.stage[data-focus]`、`.lens-doc` 网格、容器查询高度与窄容器堆叠
5. [x] Admin：公司要点页每条要点可展开「Lens 生成过程」
6. [ ] 上线后：抽查 ORCL 全部要点的 turns、warnings 与读时撤图率；在 1280 / 1024 / 720 宽度核对无横向滚动、无留白；深色与纸色主题各核一次

## 实现时的偏离

- **iframe 与页面同源**（`sandbox="allow-scripts allow-same-origin"`），而不是设计里的 opaque origin：模块脚本与字体都以 CORS 模式加载，opaque origin 会把同源资源当成跨域而拒绝，除非给全部静态资源加 `Access-Control-Allow-Origin`。frame 里只有仓库自己的渲染代码，没有模型产物，同源不改变安全边界；双方 postMessage 都校验 `event.origin === location.origin`。
- **一个格子可叠放 1–3 个块**（`LensCell = LensBlock[]`），设计里是一格一块。用真实 ORCL 数据跑审计时，"图 | judgment" 行在中等宽度下图 228px、文字 600px，失衡无法靠换 aspect 消除；允许 judgment、figures、watch 叠在图旁边的一格里，两格高度才能接近。
- **transform 的单位**：增速序列按原序列单位区分——金额变化为百分比、比率（利润率）变化为百分点（新增 `ValueUnit` 的 `points`）、倍数变化为 ×；设计里统一写成 percent 会把 −2.68× 标成 −2.8%。
- **渲染器自动稀疏周期标签**：标签宽度超过列宽时每隔一列画一个，不依赖模型设置 `periodLabels`；审计仍提示。
- **图表内 CSS 不含逐图规则**：同一页可能有多张图（对照模式、行内回退），`<style>` 在文档里是全局的；hover 与"当前列"用元素属性表达，由 frame / 页面脚本切换。

## 分期

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1 | 合同 + 共享运行时 + `legacyLens` + 站点舞台让位 + iframe 渲染（agent 未上，文档由 `legacyLens` 生成） | 现有 ORCL 要点在新舞台里以 iframe 画出，三档宽度无留白、无滚动条；行内回退可触发 |
| P2 | Lens Agent + harness + 轨迹 + Admin 展示 | ORCL 重跑后每条要点的 warnings 为空；Admin 能看到每轮 observation |
| P3 | 事件要点接入同一 agent（subject 来自 `event-findings`） | 一条 Form 4 要点用 rule/band 标在持股序列上，不加前端代码 |
