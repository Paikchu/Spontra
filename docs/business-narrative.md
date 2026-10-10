# 业务叙事（business narrative）

更新日期：2026-10-10。业务地图在每项业务的档案里加入叙事层，使用户不必再去翻投资者日、产品介绍和新闻稿就能知道：这项业务能做什么、走到哪一步、谁出钱谁买单、和替代方案比优势在哪、在财报里体现在哪些数字、什么会证实或推翻这套说法。叙事挂在财报分部上，不另起索引；脱离财报的叙事不展示。

## 结构

- 合约：`shared/analysis-contract/business-narrative.ts`（`business-narrative.v1`）。公司级：定位、阶段、判断、行业位置、叙事链、验证点；业务级：阶段、判断、能力、里程碑、相关方、对照、财报体现、叙事链、验证点。
- 阶段固定枚举：概念 / 示范 / 规模化 / 成熟 / 收缩。状态固定枚举：已证实 / 进行中 / 未知 / 失效，叙事链、验证点、里程碑共用。
- 每条陈述都带来源 id；读取端（`shared/analysis-runtime/business-narrative.ts`）剔除引用未列来源的条目，只剩不可核验内容的业务整项剔除。
- 绑定数字的文字（判断、前提、失效条件、验证条件、财报体现说明）不得写数字；数字由页面按 findings 的 `FindingRef` 词汇在所选季度解析，季度切换时同步变化。里程碑、相关方和证据可引用申报文件里的合同金额。
- 业务 `nodeId` 与流向节点一致时直接挂在该行；财报未拆分的业务（如 CoreWeave 单一报告分部下的三层服务）用 `parentNodeId` 挂到所属节点，列表里作定性行展示，点亮父节点，`anchor` 指定在列表里替代收入显示的数字（如待履约义务）。

## 读取与发布

- Pipeline 读路由 `/api/v1/companies/:ticker/business-narrative`，先读 `sec_cache` 的 `narrative:v1:<ticker>`，没有则用 `workers/pipeline/src/narrative/authored/<ticker>.json` 的人工集，两者都经同一读取器校验。
- 业务地图 Worker 的 `/api/business/v1/companies/:ticker/narrative` 转读并再次校验；`vite dev` 直接从 authored 目录提供同一文件，便于发布前预览。
- 本次只有 CRWV 的人工集（来源：FY2025 10-K、2026 Q2 10-Q、Q2 业绩公告与 2025-09 至 2026-09 的 8-K）。模型生成的工作流尚未接入；接入时应沿用 explainer 的来源抓取与 findings 的 ledger 模式，由模型只写判断与引用，数字一律走解析。

## 页面

- 列表行：业务名后跟阶段标签；财报未拆分的业务显示锚点数字和「收入未单独披露」。叙事链状态只在档案里显示，不进列表。
- 档案页签顺序固定：能做什么 → 进度 → 金主与客户 → 对照 → 财报体现 → 验证点，explainer 的自选角度排在其后。某层没有材料时保留页签并说明「材料未披露」。
- 未选业务时，同一卡片显示公司档案：定位、判断、叙事链、行业位置、验证点、各项业务。

## 业务图与运营指标（2026-10-10 增补）

- 画布新增「业务图」视图。图由叙事层声明、代码渲染：`figures[]` 里 `stack` 把能力（或公司的各项业务）分层，条目名必须与能力标签或业务名完全一致，读取器丢弃对不上的条目，少于两层不画；`ladder` 按 `metricKey` 绑定运营指标，实柱为在用、虚线框为签约或目标，图下列出每个数值的原文与来源。
- 运营指标合约 `shared/analysis-contract/operating-metrics.ts`（`operating-metrics.v1`）：开放词汇，键取公司自己的用语（active_power、data_centers、gpus_delivered），单位只有 MW、count、percent，`pairWith` 标明在用与签约的配对。每个观测带原文引用；校验规则沿用 guidance：引用必须逐字出现在原文、数字必须出现在引用里（`shared/analysis-runtime/operating-metrics.ts`）。
- 抽取器 `workers/pipeline/src/operating-metrics/extract.ts` 与 `locate.ts`：定位含数量或容量用语的段落，一次抽取加一次修复，不做模型复核。
- 定时：`spontra-operating-metrics` 工作流（`OPERATING_METRICS_ENABLED`）每个 tick 读一份最新未读的申报（10-K/10-Q/20-F 正文，或业绩 8-K 的 EX-99 附件），结果按申报存在 `operating-metrics:materials:v1:<ticker>`，每次合并重新发布 `operating-metrics:v1:<ticker>`。`spontra-business-figures` 工作流（`FIGURES_ENABLED`）在 explainer、运营指标或叙事任一变化后重新规划业务图，发布 `figures:v1:<ticker>`。电话会和 deck 走 guidance 已有的材料链路，后续可把它们也送进抽取器。
- 通用性：模型负责拆解（分几层、每层叫什么、哪些能力归哪层、哪两条指标配对），代码负责校验和画图。规划器 `workers/pipeline/src/figures/planner.ts` 只把名字（explainer 的产品名、带标签的条目、叙事的能力标签、业务名）和指标键交给模型；栈图每个条目必须是给定名字且只在一层，阶梯图每个键必须有两期以上数据，模型漏掉的配对指标由代码补一张公司级阶梯图。页面优先用叙事自带的图，其余用规划结果；下方面板的指标列表也能直接选任一张图。
- 投资者日 deck、产品页和新闻稿里的图是第二阶段：由 explainer 的网页抓取顺带收集，存 R2，模型为每张图写对应的能力条目，审核后作「资料图」显示，永不进验证点。
