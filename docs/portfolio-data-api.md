# 组合数据 API

`spontra-max-data-sync` 独立读取 IBKR、校验并保存组合。专属 D1 为 `spontra-max-data-sync-db`；主应用通过 `PORTFOLIO_DATA_SERVICE` 调用 HTTP API，没有该数据库绑定，也不保存组合副本。

## 读取

`GET https://spontra-max-data-sync.max-zhangyuchen.workers.dev/api/v1/portfolio`

公网及 Service Binding 请求都要求 `Authorization: Bearer <PORTFOLIO_READ_TOKEN>`。令牌保存在服务端 Secret，不能用于手动同步；浏览器和桌面 UI 继续访问主应用现有接口，不携带此令牌。不开放跨域读取。

响应结构由 `shared/portfolio-contract.ts` 的 `PortfolioApiResponseV1` 定义：

```json
{
  "portfolio": {
    "schemaVersion": 1,
    "generatedAt": "2026-10-06T06:00:00.000Z",
    "account": { "currency": "USD", "netLiquidation": 1000, "cashBalance": 1000, "netDeposits": 900 },
    "positions": [],
    "trades": [],
    "tradeSync": { "status": "current", "queryPeriod": "DAYS_7", "lastSuccessfulTradeAt": null, "message": null }
  },
  "reportDate": "2026-10-05",
  "syncedAt": "2026-10-06T06:00:10.000Z",
  "syncStatus": "current"
}
```

上述金额为示例。`portfolio.generatedAt` 保留组合内容生成时间，`syncedAt` 是成功同步完成时间，成功读取相同内容也会推进。交易为合并去重后的累计成交；保留累计净入金，但不暴露资金流水、账户标识或 Flex 查询配置。

- `current`：最近完成的同步成功，且未错过已过宽限期的计划。
- `delayed`：最近完成的同步失败，或应执行计划超过 30 分钟仍无成功结果。仍返回 HTTP 200 和此前成功快照。
- `uninitialized`：尚无成功快照；HTTP 200，`portfolio`、`reportDate`、`syncedAt` 为 `null`。

GET 只读数据库，不启动或等待 IBKR 同步，不写同步状态。后台同步运行时保持读取可用；数据库自身读取失败为 503，鉴权失败为 401，非 GET 为 405。所有读取响应为 `private, no-store`。主应用展示真实错误或首次同步等待状态，不回退到仓库中的示例 JSON。

## 定时与手动同步

| 所有者 | Cron（UTC） | 用途 |
| --- | --- | --- |
| 同步 Worker | `0 6 * * TUE-SAT` | 北京时间周二至周六 14:00 同步 IBKR |
| 主应用 | `*/5 * * * *` | 从组合 API 获取持仓，更新研究关注范围 |
| 主应用 | `15 * * * *` | 从组合 API 获取持仓，刷新主应用财报日历 |

手动同步继续使用同步 Worker 的 `POST /internal/portfolio/sync`，通过 `x-portfolio-sync-key` 提供 `PORTFOLIO_SYNC_KEY`。无须主应用可用。主应用原来的三个内部 portfolio/research/earnings 触发路由已退役。

写入事务保持快照与净值历史一致。相同内容仅更新同步元数据；过期结果不覆盖较新结果；最新任务的失败不会被更早结束的任务状态覆盖。周末按既有计划判断，不按简单的 24 小时间隔误报。

## 首次发布与恢复

新 D1 已单独配置。上线前在主应用 Git Build Secrets 中设置 `PORTFOLIO_READ_TOKEN`（32–512 个可打印 ASCII 字符），与 `PORTFOLIO_SYNC_KEY` 使用不同值。CI 的 `CLOUDFLARE_API_TOKEN` 需具备两库迁移和现有 Worker 发布权限。运行时原有 IBKR 与手动同步 Secrets 通过 `--keep-vars` 保留。

仅 `origin/main` 的 Git 自动构建执行 `deploy:cloudflare`；不要本地运行发布或迁移生产数据。

1. 完成构建与相关验证，应用主应用及同步服务各自迁移。
2. 为旧组合表安装阻止 INSERT/UPDATE/DELETE 的触发器，保持读取可用；复制当前快照、累计历史和资金流水，按完整内容摘要及记录数量核验。
3. 目标库在同一事务内写入数据及 `portfolio_migration` 标记。首次成功同步时间使用旧 `generated_at`，不伪造迁移时刻为同步时刻。
4. 将标记从 `copied` 改为 `activating` 后发布同步 Worker，注入读取 Secret，验证受保护 API，再标记 `active`。
5. 发布主应用并注入相同读取 Secret。CI 移除主应用遗留的 `PORTFOLIO_SYNC_KEY` 及同步服务旧反向调用的 `MAX_SITE_BYPASS_TOKEN`；原手动同步密钥仅留在同步服务。旧表继续保留只读档案；其余业务表不受影响。

切换开始前失败时，CI 解除旧表冻结；重跑时可以重新复制这期间的旧库更新。进入 `activating` 后，即使发布结果不明，也不解除冻结或重新复制；修复并再次推送，通过 CI 向前完成。`activating/active` 下再次执行迁移不会覆盖新服务产生的数据。不要直接回滚到依赖旧组合写入的版本。

## 本地验证

安装依赖后，将示例文件复制到各自被忽略的 `.dev.vars`，两个服务使用相同的测试读取令牌。将 `WRANGLER_REGISTRY_PATH` 和 `MINIFLARE_REGISTRY_PATH` 都指向同一个绝对目录，兼容 CLI 与 Vite 的服务发现；同步 Worker 使用本地 D1。

```sh
npx wrangler d1 migrations apply DB --local --config workers/sec-cron/wrangler.jsonc
WRANGLER_REGISTRY_PATH="$PWD/.wrangler/registry" MINIFLARE_REGISTRY_PATH="$PWD/.wrangler/registry" npx wrangler dev --config workers/sec-cron/wrangler.jsonc --port 8791
```

另一个终端用 `npm run dev` 启动主应用，使用同一注册目录。本地首次无数据会显示等待同步；测试使用合成数据，不导出生产账户。验证命令：`npm run check:portfolio:boundary`、`npm run typecheck`、相关 portfolio/IBKR 测试、`npm run build`、`npm run sec-cron:check` 和桌面检查。
