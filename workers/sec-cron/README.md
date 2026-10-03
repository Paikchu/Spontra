# 投资记录定时任务 Worker

Cloudflare 名称：`spontra-max-data-sync`。这是 investment-record 项目的一部分，
源码已由 `Paikchu/investment-record` 仓库维护，不需要从 earning-report-analysis 再迁入。
名称中的 `sec` 来自历史用途；当前两条 Cron 的主要职责是组合数据和财报日历。

| 计划（UTC） | 北京时间 | 当前职责 |
| --- | --- | --- |
| `0 6 * * TUE-SAT` | 周二至周六 14:00 | 读取 IBKR Flex，校验后同步投资账本 |
| `15 * * * *` | 每小时第 15 分钟 | 调用投资看板内部接口刷新财报日历 |

`index.ts` 只分派这两条计划，未知 Cron 记录日志后退出。
新财报发现、公司分析、Memory 和基本面刷新由 [`../pipeline`](../pipeline/README.md) 负责。

## 资源与代码

- `index.ts`：定时分派与 HTTP 入口。
- `ibkr-sync.ts`：IBKR 拉取、标准化和发布；复用仓库根目录 `lib/`，部署从根目录执行。
- `wrangler.jsonc`：Worker 配置和两条 Cron。
- Service Binding 指向 `investment-record`；`PORTFOLIO_SERVICE` 为计划重命名，本次仅发布文档，实际绑定名以同目录 `wrangler.jsonc` 为准。
- `IBKR_FLEX_TOKEN`、`PORTFOLIO_SYNC_KEY` 保留在 Worker Secrets 中；同步密钥须与前端一致。
- 旧 SEC 执行代码和 Workflow/R2 部署绑定已移除；历史 R2 数据未删除。
- `/health` 返回 `executor: portfolio-cron` 与 `portfolioConfigured`，不暴露凭据。
- 旧 SEC 任务请求返回 410，不会启动分析；`POST /internal/portfolio/sync` 继续要求同步密钥。

## 发布关系

推送 `main` 后，Cloudflare 为 `investment-record` 执行：

```sh
npm run build
npm run deploy:cloudflare
```

其中 `deploy:cloudflare` 依次核对/应用投资账本迁移、部署前端、执行 `npm run sec-cron:deploy`。
因此此 Worker 不需要另外连接 GitHub；Cloudflare Settings → Builds 显示未独立连接是预期状态。

单独验证或部署时，在仓库根目录执行：

```sh
npm run sec-cron:check
npm run sec-cron:deploy
```

部署脚本明确使用本目录配置与 Worker 名，移除前端构建注入的 Worker 名称覆盖，
并用 `--keep-vars` 保留运行时变量。Pipeline 的独立 Git 构建不会部署此 Worker。
