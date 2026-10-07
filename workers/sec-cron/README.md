# 组合数据同步与读取 Worker

Cloudflare 名称：`spontra-max-data-sync`。源码目录 `sec-cron` 保留历史名称；当前只负责 IBKR 数据与组合读取 API。

- `index.ts`：HTTP 路由与 IBKR Cron 分派。
- `ibkr-sync.ts`：从 IBKR 获取 Flex 报告、标准化并写入自己的 D1。
- `portfolio-store.ts`：快照、累计成交/资金流水、净值历史及同步状态。
- `portfolio-api.ts`：`GET /api/v1/portfolio`，使用独立 Bearer 读取令牌。
- `migrations/`：专属数据库 schema，不能对主应用 D1 执行。

仅保留 `0 6 * * TUE-SAT`（北京时间周二至周六 14:00）。研究持仓及财报日历任务已迁入主应用。

运行时绑定 `DB → spontra-max-data-sync-db`，不再绑定或调用主应用。Secrets：`IBKR_FLEX_TOKEN`、`PORTFOLIO_SYNC_KEY`、`PORTFOLIO_READ_TOKEN`；读取令牌与手动同步密钥独立。模板见 [`.dev.vars.example`](.dev.vars.example)。

`POST /internal/portfolio/sync` 保留受保护的手动同步。`/health` 返回配置是否齐备，不暴露凭据。旧 SEC 请求返回 410。

读取 API 始终与 IBKR 同步分离：已有快照时，上游失败仍返回 200 和 `syncStatus: delayed`；首次无数据返回 `uninitialized`，不加载示例持仓。

发布仅通过 `origin/main` Git CI，先迁移/核验组合数据并发布本服务，再切换主应用。禁止本地部署。配置、API 契约、迁移重试与恢复说明见 [组合数据 API](../../docs/portfolio-data-api.md)。本地可运行 `npm run sec-cron:check` 做 dry-run。
