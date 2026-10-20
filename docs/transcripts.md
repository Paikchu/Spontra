# Transcript 全文库

Spontra Analysis 的 `/admin/transcripts` 接口提供公司筛选、财报期间列表、采集状态和全文。后台改为只服务 BusinessView 后（2026-10-12）已移除 Transcript 页面，Admin 代理也不再转发该接口。接口沿用 Admin 登录认证，响应为 `private, no-store`。全文不经过模型摘要或截断，按供应商的发言顺序保留。

`transcript` 任务（10-Q/10-K/20-F/6-K 的 `filing.archived` 触发，每轮 1 份）从有效数据白名单公司的已归档 SEC 10-Q/10-K/20-F 中发现财报期间；外国发行人（6-K 报季度）的季度取自收入历史里首次报告该季的 6-K（期末后 120 天内，次年作为对比期的不算），同期先登记 6-K，所以以 6-K 发布第四季度时按 6-K 日期。包含历史归档；同公司同期间只建一条记录。财报指引公司（财报摘要开启）的期间优先。

财期：SEC 财报记录的财期（`sec:fiscal-period:v1:*`），否则原始文档的 DEI；年度报告对应 Q4。6-K 没有 DEI，从最近一份 20-F 的财年往后数季度。所有标签按期末排序必须递增：发行人沿用上一年的年份（Oracle 2026-08-31 的 10-Q 仍写 FY2026 Q1）时，从前一个标签按相隔季度数推出年份，只改年份（`sec/fiscal-sequence.ts`）。已存文字稿的标签被纠正时，该期清空并按新季度重新请求。无法确认财期时保留 `needs_period`，不猜测自然季度。供应商为 Alpha Vantage `EARNINGS_CALL_TRANSCRIPT`；接口未提供真实会议日期，列表显示关联财报期末。

本库是唯一调用 Alpha Vantage 的地方。存入一份文字稿发出 `transcript.stored`，指引任务把它挂到对应业绩事件，见 [前瞻指引](guidance.md)。

`company_transcripts` 在 D1 存储全文、来源链接、SEC 财报关联、财期、请求次数和采集状态。后台采集独立于 `GUIDANCE_ENABLED`，不调用模型。指引把文字稿复制为业绩事件的材料，存入私有 R2。

- `TRANSCRIPTS_ENABLED=true` 开启发现和采集。
- `ALPHA_VANTAGE_API_KEY` 使用 Worker secret 配置，不提交 Git，不进入引用链接。
- `GUIDANCE_DAILY_TRANSCRIPT_CALLS=25` 控制每日请求预算（`feature_budget` 的 `guidance-transcript`）；失败请求也计入。
- 达到每日额度时队列保留，下一 UTC 日自动继续。
- 供应商限流分两种：每日额度（`PROVIDER_DAILY_LIMIT`）当天停止请求，下一 UTC 日继续；突发限流（每秒 1 次，`PROVIDER_THROTTLED`）该期 65 秒后重试，不占当天，也不计入该期的尝试次数。日志 `transcript-library-error` 的 `provider` 字段保留供应商原话（已去掉密钥和链接）。
- 请求失败次日重试，三次失败后显示不可用；供应商明确没有文字稿或拒绝访问时保留相应状态。

上线通过 `origin/main` 自动构建。现有 `analysis:deploy` 在 CI 中先应用 D1 迁移再检查迁移并发布。`0017_company_transcripts.sql` 是新增表，不修改已有财报。Admin 与 Spontra Analysis 两个自动构建均须成功。

核验：生产需确认队列、实际全文及自动部署结果。
