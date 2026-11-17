# Discovery 代码完成度审计

审计基线：[`f522338d87bb208c249ba24204f932d2b0377458`](https://github.com/Paikchu/Spontra/tree/f522338d87bb208c249ba24204f932d2b0377458)，2026-11-16 UTC。已全文读取原始 `CRWV-earnings-feedback.md`（版本 2，505 行）与 `Spontra-分阶段构建与可靠性验收.md`（352 行），并核对 [输入清单](input-manifest.json)、[项目规则](../../../AGENTS.md)、[设计规范](../../../design.md) 和本目录实际结果。仓库未发现 `.agents/skills`；审查后端时读取了 Cloudflare Workers、Agents SDK 和 Durable Objects 技能，安装版本为 `agents@0.33.0`。

本次先只读审计，再按主任务指示新增本文件；未修改业务代码、原需求或已有验收结果，未启动模型、报告生成、付费研究或生产写入。代码修复由其他执行节点承担。下表区分代码机制、已有证据和未完成的内容验收；不表示本次重新执行了所有历史旅程，也不表示 G0–G10 已全部通过。

## 已证实的问题与修复状态

本审计确认 3 个 P1，未发现 P0。G5/G6/G9和阅读改进已完成代码及本地旅程，最终发布与真实只读验收由总记录更新。

| 问题 | 可复现证据与影响 | 最小修复及验收 | 状态 |
| --- | --- | --- | --- |
| G5 公共研究适用性门禁不一致 | 基线 `company-research/context-tools.ts:18–23` 的通用 `precheck` 只要求读过公共研究并为正文引用登记决策。实际调用 `read_public_research({})` 后，即使冻结上下文包含宏观报告、`researchUses=[]`，`precheck` 也返回 `null`。财报 `recipe.ts:110` 与专题 `analyst/agent.ts:369` 使用此门禁；公司研究和估值另有逐报告检查，造成路径差异。 | 在共用门禁要求每份冻结公共报告至少有一条明确的采用／驳回／不适用理由；无需强迫采用或逐条处理全部 claim。验证只读目录、只读 claim、漏第二行业均拒绝；显式不适用可通过；无覆盖与旧 checkpoint 合法；既有公司证据和冲击去重规则不回归。 | 修复及本地旅程通过，待最终发布读回 |
| G6 敏感性结果可能误升为可量化结论 | 本地真实 `periodicTools` 旅程：`revenue_exposure` 使用 `exposureBasis=assumed_sensitivity`，数值叶均引用已登记数值，得到 `revenueChange=40000000` 及 `Sensitivity only; exposure is an assumption, not an event forecast.`；随后 `record_investment_impact(quantificationStatus=quantifiable, missingInputs=[])` 被接受。基线计算器使用分号，而财报和专题门禁仅匹配 `Sensitivity only:`。 | 使用明确的机器分类并在财报／专题统一检查，保留计算中的假设谱系，避免后续计算把敏感性中间值作为事实提升等级。验证敏感性不可升级、`sensitivity_only` 可用、缺失输入继续阻断，原黄金用例通过。 | 修复及本地旅程通过，待最终发布读回 |
| G9 已停止任务缺少完整阶段草稿读取入口 | 实际已留存的停止前后回执一致：行业任务 `public-30341edbe44d240573a3508661795e7aa9afbdcd` 已使用 63/96 次调用；综合阶段 5 轮，成功返回 `saved:true, claims:19`；独立审阅 2 轮后停止。最终 `stopped/terminated`、全部 session 不活跃、`result_version=null`、`draft=null`。`generation.ts:293–301` 只在审阅完成后保存最终草稿；`PiHost.sessionsReport()` 仅导出 trail，而成功 `submit_report` 输入在 `host.ts:662` 被截为 4000 字符。完整 state／步骤结果仍被持久化，不能据此说草稿已丢失。 | 增加只读的已结束阶段检查点导出，直接读取持久化 spec/state，不调用可能执行启动／结算的 `poll`、`finish`、`bound` 或恢复函数；必要时增加未来各阶段不可变检查点保存。导出不改变停止状态、调用数、公开指针或审核资格。验证超过 4000 字符的完整草稿、尾部来源和哈希，重复读取一致，活跃／错任务／错阶段拒绝，零新增模型调用。 | 修复及本地运行时旅程通过，待最终发布读回 |

上述工具模拟均使用本地合成数据，未发布合成结果。第二项复现针对计算分类门禁，不代表生产 CRWV 或 NBIS 报告已经发生相同误标。

另有已确认的入口可发现性问题：`ResearchList` 整张卡片可点击，但没有明确“阅读全文”提示，用户容易将摘要误认作全文。该 UI 改进正在独立处理。实际宏观详情已经保存并渲染约 37,237 字符、7 个章节、21 条 claim、12 份来源；不能将列表中的约 424 字摘要当作正文缺失。真实点击与滚动验收由发布节点记录。

## G0–G10 对照

| 关卡 | 代码与已有证据可支持的范围 | 本轮代码状态／仍须区分的验收 |
| --- | --- | --- |
| G0 基线 | [基线](g0-baseline.md)、[输入清单](input-manifest.json) 记录起点提交、部署、材料和缺口；测试材料明确与正式研究隔离。 | 基线机制与记录已有。最终修复提交和部署须另作精确读回；不混用起点与最终版本。 |
| G1 证据与发布 | [`public-research-schema.ts`](../../../shared/analysis-runtime/public-research-schema.ts)、[`public-research.ts`](../../../shared/analysis-runtime/public-research.ts)、[`store.ts`](../../../workers/analysis/src/public-research/store.ts) 实现来源身份、日期、单位、claim 与依赖校验，完整对象先写入及原子指针切换。已有 [37 项本地旅程](results/public-research.json)、[发布竞争／中断](results/artifact-publication.json)、[真实 CRWV 翻译](results/production-crwv-translation.json)。 | 核心机制已有；未发现需另扩展的 P0/P1。已保存翻译验收不等于所有历史文章都已重译，外部链接也未逐一导航。 |
| G2 宏观 | [`generation.ts`](../../../workers/analysis/src/public-research/generation.ts) 已有两路取证、共享原文、综合、独立反证和一次定向修复；宏观自动审查模式与 CAS 发布已实现。已有 [政策旅程](results/macro-policy-journey.json)、[实际发布读回](results/macro-automatic-release.json)、[逐 claim 复核](results/macro-final-independent-review.json)。 | 宏观人工审核已由用户明确取消，不能继续作为阻塞，也不能登记为用户已审阅。当前发布是 `limited` 覆盖；未覆盖变量是研究缺口，不是凭数量补造内容的理由。 |
| G3 行业与映射 | [`context.ts`](../../../workers/analysis/src/public-research/context.ts) 支持显式、多行业、版本化暴露和未知权重；行业可直接读冻结公司材料。增量 enrichment 复用原 notes／草稿并绑定精确宏观。已有 [多行业与事件旅程](results/industry-event-independent.json)、[原始财报读取](results/industry-original-filings.json)、[增量旅程](results/industry-enrichment-journey.json)。 | 代码机制已有。真实行业任务已停止，尚无已发布行业报告；不属于首页没有读取能力。不得重启任务或把未审稿登记为通过。 |
| G4 首页与阅读 | [`PublicResearch.tsx`](../../../apps/business-site/src/PublicResearch.tsx)、[`PublicResearchPage.tsx`](../../../apps/business-site/src/PublicResearchPage.tsx) 已有两类入口、行业查找、固定版本、来源、历史、错误／撤回／过期状态。已有 [键盘与窄屏](results/public-reading-keyboard.json)、[可访问性](results/public-reading-accessibility.json) 及宏观真实阅读证据。 | 主要读取机制已有；入口明确性和阅读层级已改进，五视口及触屏可访问性旅程通过。最终 UI 应重验真实首页→完整宏观正文→来源→刷新／返回，行业继续明确显示未发布状态。 |
| G5 公司复用 | 冻结版本、按 claim 登记公司适用性、公司证据要求、同冲击去重与依赖失效已有工具和存储实现。已有 [公司宏观读回](results/company-macro-context-readback.json)、[时间负向](results/company-macro-cutoff-negative.json) 与多行业合成证据。 | 上表 P1 门禁已修复，27项/36次工具操作旅程通过。双公司真实影子内容与实际行业采用尚未验收，当前禁止触发生成。 |
| G6 投资传导 | [`periodic.ts`](../../../workers/analysis/src/filing-analysis/periodic.ts)、[`analyst/agent.ts`](../../../workers/analysis/src/analyst/agent.ts)、[`price-impact.ts`](../../../shared/analysis-runtime/price-impact.ts) 已有假设变化、影响链、确定性计算、反证／验证节点与缺口状态。已有 [19 项计算／工具旅程](results/price-impact.json)。 | 上表 P1 分类与谱系已修复，52项工具操作及19项计算旅程通过；应复验固定债、现金及股数、期间、缺失与零等黄金用例。真实投资链质量仍须在用户恢复生成后审阅。 |
| G7 要点归属 | [`findings/articles.ts`](../../../workers/analysis/src/findings/articles.ts)、[`finding-association.ts`](../../../apps/business-site/src/finding-association.ts)、[`FilingReport.tsx`](../../../apps/business-site/src/FilingReport.tsx) 已有最终结论标题、文件／财季归属、跨季事件来源关系、未完成状态及旧链接兼容；`findings.published` 下游保留。已有 [事件来源关联](results/event-source-association.json)、[旧链接](results/historical-links-fixed.json)。 | 已有机制和旅程，未另确认 P0/P1。无匹配专题保留明确公司级入口；不能强挂最新财报或删除独立证据。新影子归属验收待后续内容产生。 |
| G8 统一估值 | 价格影响摘要与估值页复用 [`priceImpactOf`](../../../shared/analysis-runtime/price-impact.ts)；冻结报价、独立更新行情、三情景点、失效依赖及个人不可变敏感性已接入。已有 [17 项保存／读取](results/valuation-adjustment.json)、[历史上下文](results/valuation-context.json)、[实际私有调整](results/production-private-adjustment.json)。 | 无匹配、受控的事件前后模型时，事件增量明确不可量化；公司估值空间与个人敏感性不能冒充事件影响。该内容缺口不单独列为本轮新增代码缺陷。 |
| G9 增量可靠性 | public source→claim→industry→company／valuation 依赖、精确失效、100 次事件幂等、single-flight、调用数硬门禁、停止、保留最后发布版本已有实现。已有 [API 旅程](results/public-api.json)、[8 项真实 SDK 模拟供应商预算](results/provider-budget.json)、[精确事件](results/public-critical-event.json)。 | 上表 P1 完整阶段读取已修复，40项本地Cloudflare运行时操作旅程通过。调用数硬限与基于已报告用量的 token 软阈值必须分别说明；用户已暂停真实生成，不能以预算授权继续执行。 |
| G10 交付与回滚 | 已有 additive migrations、影子与人工提升、公开版本撤回／恢复、精确提交 CI／部署记录和 [本地 11 项回滚](results/local-rollback-drill.json)。 | 最终补丁须完成适用检查、合成正反旅程、精确 commit／CI／生产版本核验与真实只读页面验收。完整行业／双公司真实内容链、NBIS 原图人审及生产回滚时延尚未完成；不得写成 G10 全通过。 |

## 收尾边界

当前可独立完成的是上述三个 P1、入口提示及其代码／合成旅程／授权部署验证。待修复完成后，应将最终提交、具体命令结果、部署版本、只读生产结果追加到 [总记录](README.md) 或本文件，不能以审计表代替执行证据。

真实宏观／行业／公司生成均按用户最新要求暂停；已停止行业任务不恢复，已发布宏观保持可读，NBIS `126008` 原图人工签核要求保留，`126238` 完整原文不重复准备。现有 10 errors／5 warnings 的 lint 溯源见 [lint-provenance.md](lint-provenance.md)，本审计不扩展其整改范围。
