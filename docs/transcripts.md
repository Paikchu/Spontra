# Transcript 全文库

Admin `/admin/transcripts` 提供公司筛选、财报期间列表、采集状态和全文阅读。所有接口沿用 Admin 登录认证，响应为 `private, no-store`。全文不经过模型摘要或截断，按供应商的发言顺序保留。

生产每 2 分钟从有效数据白名单公司的已归档 SEC 10-Q/10-K 中发现财报期间，并处理一条采集任务。使用已有的 `*/2 * * * *` 定时器，在财报维护任务前运行，维护队列不会跳过 Transcript 采集。包含历史归档；同公司同期间只建一条记录。原始 SEC 文档的 DEI 确定财年、财季，年度报告对应 Q4。无法确认财期时保留 `needs_period`，不猜测自然季度。供应商为 Alpha Vantage `EARNINGS_CALL_TRANSCRIPT`；接口未提供真实会议日期，列表显示关联财报期末。

`company_transcripts` 在 D1 存储全文、来源链接、SEC 财报关联、财期、请求次数和采集状态。后台采集独立于 `GUIDANCE_ENABLED`，不调用模型。指导信息工作流仍将自己的材料存入私有 R2。

- `TRANSCRIPTS_ENABLED=true` 开启发现和采集。
- `ALPHA_VANTAGE_API_KEY` 使用 Worker secret 配置，不提交 Git，不进入引用链接。
- `GUIDANCE_DAILY_TRANSCRIPT_CALLS=25` 控制 Transcript 库与 guidance 共享的每日请求预算；失败请求也计入。
- 达到每日额度时队列保留，下一 UTC 日自动继续；供应商限流时当天停止请求。
- 请求失败次日重试，三次失败后显示不可用；供应商明确没有文字稿或拒绝访问时保留相应状态。

上线通过 `origin/main` 自动构建。现有 `worker:pipeline:deploy` 在 CI 中先应用 D1 迁移再检查迁移并发布。`0017_company_transcripts.sql` 是新增表，不修改已有财报。Admin 与 Pipeline 两个自动构建均须成功。

核验：`tests/pipeline/transcripts.test.ts` 使用真实 SQLite 验证归档发现、白名单、跨日预算、财期映射、完整正文持久化和 Admin 认证；生产需另外确认队列、实际全文及自动部署结果。
