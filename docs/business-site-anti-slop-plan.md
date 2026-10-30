# Business View 去 AI 味改进方案

审查对象：线上 `spontra-business-map`（首页 `/` 与公司页 `/companies/ORCL`），2026-10-30 在 1440×900、800×600、375×812 三种视口及明暗两种主题下截图核对；源码对应 `apps/business-site/src/`。

判断标准来自 anti-ui-slop 的硬门槛：页面的用途一眼可见；一个主操作领导层级；每个控件都有真实结果；文案与内容只属于这个产品；加载 / 空 / 错误状态可达；响应式是有意为之；整体不能换个产品名照用。

## 结论

这个站最独特的资产是 **按业务拆分的收入→利润 Sankey、带指引刻度的趋势图，以及每条 finding 都能回溯到 SEC 原文** 的能力。现在的问题是这些资产被包在一层通用壳子里：落地页三段式 hero、三列卡片网格、"How it works" 图标三栏、雷达评分、分段胶囊堆叠、发光 Ask 环、角落聊天气泡。把壳子拆掉、让 Sankey 和证据链成为视觉身份，是整个方案的主线。

下面按优先级排列，每条给出证据、原因和改法。

## P0 — 可读性与身份（先做）

状态：2026-10-30 全部 20 条已在前端实现（估值页三条见 `ValuationPanel.tsx`、`valuation-prose.ts`；首页见 `Home.tsx`、`home-strip.ts`；公司页控件、Ask、导览、要点标记见 `BusinessMap.tsx`、`stage.css`、`tour.ts`、`LensPanel.tsx`）。暗色主题同日改为纯黑。两处留给后端：正文里 "(mine, not disclosed)" 一类作者旁白要在 Spontra Analysis 的估值提示词中去掉；首页每行的迷你收入→利润流程图读 `HomeCompany.statement`，由 `home-digest.ts` 新增，Spontra Analysis 发布前首页回落到营收柱条。导览不再首访自动弹出，但 rail 里 "怎么看这一页" 仍可按需走一遍。

### 1. 估值页正文是"模型草稿直出"

证据：`/companies/ORCL` 默认落在 Valuation。Summary 之后是一段约两千词的连续正文，段内夹着全大写的伪标题（PUBLIC FACTS、MANAGEMENT GUIDANCE、RESEARCH ASSUMPTIONS (mine, not disclosed)、READ-THROUGH、IS THE MARKET-IMPLIED PATH ALREADY THE BASE CASE?），行宽接近 110 字符。

原因：这是整站最强的"AI 写的"信号。读者看到的是模型的工作稿，不是产品。

改法（`ValuationPanel.tsx` + `valuation.css`）：
- 正文行宽限制在 `max-width: 68ch`，段落之间留空，而不是靠句号堆叠。
- 全大写伪标题由后端分段结构承载（`thesis` 已有 Summary / Thesis / Expectations gap / Catalysts / Counter-evidence / Next checks 六段）；正文内部再出现的 ALL CAPS 片段在渲染时转为 `<h4>` 小标题或直接要求模型不要写。
- 首屏只放 Verdict 一句 + Value per share 区间 + 五个维度各一行理由；Thesis 全文折叠在 "Read the full thesis" 之后。
- "(mine, not disclosed)" 这类作者旁白不应出现在面向用户的文本里，在 harness 的审稿 pass 中剔除。

### 2. 机器标识符直接暴露给读者

证据：Gaps 区块显示 `assumption_out_of_history_range`、`tv_share_high`；正文内引用是 `e024` `5649` `fd0b` `875e` 这样的四位哈希胶囊，一句话里最多并列五个。

原因：读者无法用这些标识做任何事；它们是调试信息。

改法：
- Gap 代码只保留它的句子（"Bull revenue growth 25.2% is outside the company's history (6.0% to 21.6%)"），代码进 `title` 或管理后台。
- 引用改为顺序脚注 `¹ ² ³`，脚注列表写来源的人话名（"10-Q Q1 FY2027, Liquidity"、"Earnings call 2026-09-10"），点击打开原文。一句话内多个来源合并为一个脚注号区间。

### 3. 雷达图 + 综合分是通用"AI 选股工具"模式

证据：顶部 "4.6/10 · Composite score · Confidence Medium"、五轴雷达、五条进度条每条尾部都是 "Medium"。

原因：五轴雷达几乎不承载信息（面积无意义，轴序任意），而 "x/10 综合分" 是每个 AI 分析页都有的东西；它让 Spontra 看起来和它们一样。

改法：
- 删除雷达。五个维度改为一列，每行：维度名、分数、**一句话理由**（后端已有 evidence，现在没显示）。
- "Composite score" 改成直接陈述结论："Valuation safety 1.0 pulls the composite to 4.6"，让数字跟着判断走，而不是判断跟着数字走。
- 置信度只在不是 Medium 时显示。

### 4. 舞台顶部指标卡被截断

证据：1440 宽下三张 highlight 卡标题显示为 "Cloud infrastructur…"、"Operating…"、"Cloud…"，两张卡截断后同名。800 宽下同样。

改法（`BusinessMap.tsx` 高亮行 + `style.css` 的 tile 样式）：标题允许两行；`verifyHighlights` 加标题长度上限（≤ 22 字符）让模型给短标题；卡片宽度随标题，不固定三等分。

### 5. 首页 hero 依赖 opacity-0 入场动画

证据：H1、eyebrow、搜索面板都用 `animation: rise … both` 从 `opacity: 0` 进场（`style.css:1053`、`:1058`）。在 375 宽模拟下截图时三者停在 opacity 0，首屏除了 eyebrow 只有空白，搜索框不可见。线上真机需再核；但只要动画被暂停（后台标签、预渲染、打印、bfcache 恢复），主操作就会消失。

改法：H1 和搜索框不做透明度入场；装饰元素才动。要动的话用 `@starting-style` 的 transition，没有 `both` 填充的终态风险。

### 6. 首页吸顶导航压住 "Recently viewed"

证据：首页向下滚一屏，导航文字 "Findings · Companies · How it works" 与 Recently viewed 的芯片重叠在同一行。

改法：导航加不透明背景与正确的层级，或芯片行不参与吸顶。

## P1 — 拆掉首页的落地页模板

### 7. "How it works" 三图标栏

证据：页脚上方三栏，线性图标 + 短标题 + 一句说明（Find a company / Read the business map / Check the findings）。

原因：这是 coding agent 的默认区块，内容也只是复述导航。

改法：删除。真正的"怎么用"是公司页里的 "How to read this page"，留一个入口即可。

### 8. "Worth watching" 三列卡片网格

证据：六张等高卡，页脚一律 "3 more for this company · See evidence"。

原因：同款卡片重复 + 泛指标签（See evidence 指向哪里不明）。

改法：改为按公司分组的紧凑列表：logo、ticker、季度、finding 标题、severity、一个具体动作文本（"Open in cash flow"）。一家公司的三条 finding 排在同一组里，不再出现 "3 more"。

### 9. "Companies covered" 卡片

证据：16 张卡，公司名截断成 "JP Morgan …"、"Microsoft C…"、"Taiwan Sem…"；没有 finding 的卡左下显示 "—"；所有卡一样的橄榄色八柱 sparkline。

改法：
- 改表格行：ticker、全名、最新季度营收、YoY、报告期、finding 数。名字不再截断。
- 把橄榄色柱状 sparkline 换成该公司 **缩略 Sankey**（收入→成本→利润三段，单色）。数据页面已经加载；这是只有 Spontra 能画的图，也是首页最该有的视觉身份。
- "—" 改为不显示；真的要显示就写 "No findings yet"。

### 10. 同一事实说三遍

证据：eyebrow "FROM SEC FILINGS · 16 US COMPANIES COVERED"、搜索框下 "Source: SEC EDGAR · Updated after each filing · Last update 7 days ago"、页脚 "Source: SEC EDGAR · Updated after each filing"。

改法：保留一处，放在搜索框下，带上最近更新日期。页脚只留免责声明与隐私。

### 11. 背景的径向品牌光晕

证据：`style.css:108` 顶部 `radial-gradient` 品牌色光晕叠在点阵上。

改法：去掉光晕。点阵可以留作统一底纹（整站一致，有辨识度），光晕没有产品理由。

### 12. 导航与文案

- 导航 "How it works" 随第 7 条一起删；"Findings / Companies" 是锚点跳转，改成真正的页面段落标题滚动即可，不必做成导航。
- Hero 副标题 "Every filing turned into a business map…" 与 H1 重复；二选一。
- 手机端 eyebrow 的 letter-spacing 大写在 375 宽下折成两行且字距拉开，改为普通大小写一行。

## P2 — 控件与外壳

### 13. 胶囊分段控件堆叠

证据：公司页趋势区上方同时有 YoY/QoQ、Summary/Detail、Trend/Metrics、Revenue/Growth drivers、视图 tab、事件过滤芯片，全部是同一种 999px 胶囊；手机端四行胶囊占满一屏。

改法：只给 **视图 tab** 保留胶囊样式；其余二选一切换改为带下划线的文字开关或 `<select>`（Revenue · By business 已经是下拉，统一到它）。目标是一个层级一种控件。

### 14. Ask 的发光环与模糊幕

证据：`stage/stage.css:72-77` conic-gradient 旋转环 + blur(6px) + 三层 backdrop-filter 幕布。

原因：这是"AI 功能"的标准视觉提示，正是要避免的。

改法：Ask 做成普通输入行：文本框 + 发送按钮，placeholder 写具体可问的问题（"Why did free cash flow turn negative?"）。进度用现有的 `ask-progress` 细条即可。

### 15. 手机端右下角聊天气泡

证据：375 宽下绿色圆形 FAB 盖住 findings 列表第三行文字。

改法：去掉 FAB；Ask 入口放在视图 tab 行末或 findings 段标题旁。

### 16. 首访 coach-mark 导览

证据：三步弹窗（Skip / Next / 三个点），遮罩挡住舞台。

改法：删除导览组件（`CompanyTour.tsx`），保留 rail 里 "How to read this page" 链接打开同样的三句说明。首访不弹。

### 17. Severity 的三重编码

证据：首页卡片 "Risk ●●●"，rail 里红色数字 "3"，tooltip "Risk · Severity 3"。

改法：全站统一一种：数字徽标（已经最紧凑）；"Risk" 字样只在需要区分 kind 时出现。

### 18. 隐私声明位置

证据：每个公司页的 rail 底部都有 "We collect anonymous usage stats only. No cookies."。

改法：只在首页页脚出现一次；公司页 rail 底部放 "How to read this page" 与数据日期。

### 19. Sankey 次级标签过小过淡

证据：1440 宽下 "Non-operating income, net"、"Income taxes"、"Interest expense" 约 9px、低对比。

改法：label 最小字号 11px；非焦点节点用 `--muted-foreground` 而不是 `--faint`。

### 20. 大数字字体

证据：手机端 hero 指标 "$19.3B / $5.6B" 用 Geist Mono，看起来像终端输出。

改法：大数字用 `--display`（Newsreader）或 Geist tabular，与估值页 `val-score` 一致。

## 状态核对

- 加载：舞台有 shimmer 骨架（`stage.css:123`）。可改为 Sankey 轮廓骨架，减少通用感；非阻塞。
- 空：首页 "Nothing new in this category"、"Findings still generating" 可达。
- 错误：`ErrorState.tsx` 覆盖 404 / 限流 / 服务器 / 数据不足，文案是标准提示语，保留。
- 权限：无登录，不适用。

## 实施顺序

1. P0 第 1–3 条一起做（估值页），一个 PR。
2. P0 第 4–6 条（截断、动画、吸顶），一个小 PR。
3. P1 首页重排（第 7–12 条），一个 PR；缩略 Sankey 是其中工作量最大的部分，可以先用单色三段条占位再换。
4. P2 按条独立提交。

## 不改的

- 点阵底纹、Newsreader 标题字体、橄榄/青绿配色：已形成一致的站内语言，和同类产品不同，保留。
- Sankey 的指引刻度、YoY 条纹、finding 焦点态的全舞台文档：这是产品本身，不是壳。
