# 业务脑图：ReAct 拆解公司业务

日期：2026-10-11。状态：已实现，尚未上线；线上首轮运行结果待核验。

## 一句话

用户在业务地图上点中某个业务（如 MSFT 的智能云）后，原来的文字档案换成一棵脑图：它从桑基图上这个业务的节点向左长出，依次是产品线 → 具体产品 → 赚钱方式。树由 Pipeline 里的 ReAct 研究员（DeepSeek + Tavily）逐项业务一步一步拆出来，每个节点都要有一段把它归入上级的原文。

```
赚钱方式      产品                   产品线          财报业务（桑基图）
[按用量计费] ─┐
[预留容量]   ─┤
Azure AI Foundry ─┼─ Azure ──────┐
Azure Arc     ─┘                ├──────── 智能云 $39.3B ──▶ 收入
[按核心授权] ─── SQL Server ────┤
GitHub Copilot ─ GitHub ────────┘
```

## 拆解层级

1. 公司 → 财报业务：直接来自已发布的 SEC flow（`quarter.segments` 及其披露的 children），不让模型猜。只有某一层的分部全是地区时才不拆（AAPL 这种按地理组织的公司，各地区卖的是同一套产品线）；地区分部和产品分部混在一起时（AMZN 的 North America、International、AWS）每个都拆。
2. 财报业务 → 产品线 → 产品：ReAct 研究员负责，最多 3 层、每个节点最多 10 个下级、每项业务最多 40 个节点。财报自己披露的下级业务（如 ORCL cloud 下的两项）预先放进树里（`flowNodeId`），产品挂在它们下面。
3. 赚钱方式：挂在材料能证明的那一层（多在产品线），`type` 为 subscription / consumption / license / transaction / advertising / hardware / services / other，`label` 是地图上的短标签（≤10 字），`text` 一句话说明谁付钱、按什么付。

## ReAct 循环

代码：`workers/pipeline/src/business-tree/agent.ts`（纯逻辑，可注入模型、搜索和 step），`workflow.ts`（Workflow、扫描、读取）。

每项业务一轮循环，预算 16 轮（模型回复次数）、6 次搜索、6 次读页。每轮：

- think + act（v10，2026-10-18）：动作是 Claude 的客户端工具 `search {query}`、`read {source, focus}`、`add {parent, nodes}`、`revise {id, …}`、`remove {id}`、`finish {}`，schema 均为 `strict: true`，参数必定符合 schema。Sonnet 5.5 不接受强制 `tool_choice`，所以用默认 auto，系统提示要求每次回复都调用工具；一次回复里的多个调用按顺序执行（每轮最多 4 个）。
- 对话只追加：开头一条 user 消息是任务、当前树、来源列表、预算和年报业务段；之后每次回复原样（含 thinking 块和签名）作为 assistant 消息回传，每个调用的结果作为对应的 `tool_result` 跟在后面，结果末尾附剩余预算。之前的轮次从不裁剪或改写：Claude 的 thinking 块只在系统提示、工具和历史都不变时有效，改了历史会被丢弃或报 400。整段对话走 prompt cache（系统提示一个断点，加顶层自动缓存）。
- 深度：10-K 往往只写类目（compute、storage、online stores）。模型调用 finish 时，若还有一级节点既没有下级产品也没有赚钱方式，且搜索预算未用完，harness 会提醒一次去公司产品页和定价页补上具名产品和收费方式。
- 之前的做法及失败原因：v7 把历次 thought/action/observation 塞进一条 user 消息，被当作伪造对话记录拒答；v8 要求逐轮写出 thought，被判为套取推理（`refusal`，`reasoning_extraction`）；v9 要求以文本返回 JSON 决定，Claude 会在 JSON 外加说明文字（`invalid_json`）或直接发起工具调用（`ended with tool_use`）。
- 拿不到可用回复（拒答、在输出上限被截断、流中断）的一轮不进对话，下一轮原样重发；连续 3 次时运行带着原因结束，由管道稍后自动重试。回复里没有工具调用时提醒一次，连续两次则以现有结果结束这项业务。服务端 fallback 在回复中途换模型时，换模型前的 thinking 和工具调用不回传、不执行。
- observe：harness 把执行结果写成下一轮的 observation。`add` 逐个核对节点，通过的给 ID，未通过的写明原因（例如“anchor 没有同时写出 Azure 和它的上级”），模型下一轮可以改。

搜索和读页是 durable step（`tree-b{n}-t{k}-{i}-search/read`，i 是这轮第几个调用），模型调用也是（`tree-b{n}-t{k}-act`，结果是回复的原始内容块）；增删改节点是纯函数，Workflow 重放时按 step 结果重建同一棵树和同一段对话，来源编号也一致。HTTP 错误和超时仍由 step 重试。

SEC 文件全部来自文件库（`docs/sec-filing-library.md`）：开始前从文件库列出最近一份 10-K 和 flow 自身的文件，不再用网络搜索找年报；对 SEC 来源的 read 是 D1 查询，返回按 focus 排序的原文段落；网络搜索只用于厂商页面。每项业务开始前，文件库把年报里这项业务自己的章节（标题点名该业务的小节及其下级，否则按业务名排序的 Item 1 段落）作为“已读”材料放进开头消息，不占读页预算。

各项业务并行研究：每项业务有自己的来源编号（`b1-s1`、`b2-s1`…）和步骤名，结束后按 URL 合并、按业务顺序重新编号为 `s1…sN`，`sources` 只含被引用的来源。关键路径上的顺序模型调用从“各业务轮数之和”降为“最长的一项业务”。

## 核对（写入和读取用同一套规则）

- anchor：必须是模型本次运行读到的某个来源中的原文（压缩空白和标点后逐字匹配），≤600 字符，并且同时写出节点名（完整词，不是前缀）和某个上级的名称（父节点、更上层节点或这项业务；公司只披露一项业务时，公司名也算；公司名取发行人在申报文件里的写法，如 “Cloudflare, Inc.” 和 “Cloudflare”，不用交易所的证券名称 “Cloudflare, Inc. Class A Common Stock”）。原文用 “this segment” 指代上级时，要把点出上级名称的前一句一并引用。 财报常先用一句点出板块（"This segment primarily comprises:"），再把产品线分条列出：此时 anchor 可以用 " … " 连接同一段落里最多 3 个原文片段，每段逐字存在、顺序一致、整体跨度不超过约 2,400 个字母数字（`quotedIn`）。多段引用只取正文：表格行（如全公司收入表）不能当片段，因为它说明不了某条产品线属于哪个板块。
- gloss / summary / revenue：引用已出现的来源，不含金额、比例、增速等数字，文字里写的来源编号会被去掉（`withoutCitations`）；revenue 的来源还必须提到该节点或其上级。
- 独立审校：每项业务结束后，审校模型拿到每个节点及其来源中提到它的句子，只能删除整个节点或单个字段；两次都拿不到合法结果时，保留已通过 harness 的内容。
- 读取：`shared/analysis-runtime/business-tree.ts` 的 `readBusinessTree` 用同一套 `harnessNode` 重新核对，失败的节点连同下级删除，没有内容的业务不展示。

## 存储、触发与读取

- 结果存 `sec_cache` 的 `business-tree:v1:{ticker}`，版本记录走 `AiRunStore`（kind `tree`）。研究过程（每轮 thought / action / observation）存在同一文档的 `research` 字段，仅后台可见。
- 触发：事件驱动（docs/pipeline-events.md）。`financials.published` 和后台开关发出的 `feature.settings`（`feature: "tree"`）会排一次 `tree` 任务；业务列表指纹与已发布的不同时才启动 Workflow。名单为 `BUSINESS_TREE_TICKERS` 加 AI 名单，再按后台的公司开关增删。需要 `TAVILY_API_KEY` 与 `DEEPSEEK_API_KEY`。
- 开关（2026-10-17，后台「白名单」的「业务脑图」列，与其余功能同一套，见 [businessview-admin](businessview-admin.md) 的功能开关）：存于 `business_feature_settings` 的 `tree` 行。
  - 全局生成：`*` 行覆盖 `BUSINESS_TREE_ENABLED`。关闭后不再启动新运行，已排队的运行以 superseded 结束，已发布的树照常显示；重新打开时为名单内每家公司检查一次是否需要生成。
  - 每家公司一个开关：开 = 在名单内并展示，打开需先在白名单中，打开后立即检查生成；关 = 移出名单，公开读取接口返回 `status: "hidden"`，地图退回文字说明，存储的树不删，后台仍可查看。没有存储选择的公司按 `BUSINESS_TREE_TICKERS` 加 AI 名单决定。每次切换都发出 `feature.settings`，地图的 company 版本号随之更新，读者马上看到变化。
- 后台：AI 任务页新增“业务脑图”，可手动重跑，查看每轮步骤、树和研究过程。
- 读取：Pipeline `GET /api/v1/companies/:t/business-tree`（只读 D1），地图 Worker 与 flow、解读、指引一起取回并复核，去掉 `research` 后作为 `tree` 返回。

## 地图上的画法

- `apps/business-site/src/mindmap-layout.ts`：右到左的整齐树布局。第一列从桑基图最左列所有标签的左侧开始，主干从被点业务的标签左端水平引出，不穿过其他业务的标签；赚钱方式是节点下级里的绿色胶囊，排在产品之前。
- 布局有单行和双行两种节点，`FlowChart` 按当前画布比例都算一遍，取聚焦后字更大的那种。脑图画在桑基图的同一坐标系里，画布范围（world）向左扩展；“适应画布”看全图，“聚焦业务”框住脑图和该业务到收入的路径，字号不超过原来聚焦时的大小。
- 点节点或胶囊，在图下方（要点和财报卡片出现的位置）打开说明：是什么、赚钱方式、归属原文和编号来源；再点一次或 ✕ 关闭。
- 被点业务若有财报披露的下级，脑图挂在每个下级上。没有树的业务仍显示原来的文字档案。

## 已知限制

- 全部按地区划分分部的公司（如 AAPL）和只按银行、保险口径绘图的公司暂不拆。
- 产品名保留材料原文（多为英文），中文靠 gloss。
- 首轮线上运行后需要看后台的研究过程，调整提示词和预算；改动后提升 `BUSINESS_TREE_VERSION` 会让每家公司重跑一次。

待办与优化项见 [business-tree-backlog.md](business-tree-backlog.md)。
