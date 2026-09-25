# 财报分析 Pipeline

代码来源：`Paikchu/earning-report-analysis` 的 `7dba791f18bf9740924bbbba6efbf4c3a202f382`。
迁入 `Paikchu/investment-record` 后仍独立部署为 `earning-report-analysis-sec-pipeline`。

## 责任边界

- `src/`：SEC 发现、AI 分析、公司分析、Memory、Yahoo 基本面、只读 API 和 Cron。
- `migrations/`：分析数据库的完整历史；文件名和内容与来源保持一致。
- `shared/analysis-contract/`（仓库根目录）：供分析后端使用的共享类型。
- `tests/pipeline/`（仓库根目录）：迁入的后端测试、SQLite D1 测试工具及合成数据。
- 投资看板仍通过 `EARNING_REPORT_PIPELINE` Service Binding 或服务端 HTTPS 读取结果。
  分析 D1 与投资账本 D1 是不同数据库，不能混用。

个股「业务拆解」由公司分析 Workflow 在 SEC Memory 更新后生成。它读取最多四期已发布 SEC 报告、复用 Web Search 的 Tavily 检索与网页提取，最多执行九次取证工具调用，完成逐段引用核查后发布到原公司分析读取 API；旧版「业务前瞻」仍可读取。生成需配置 `TAVILY_API_KEY` 和现有模型密钥，不依赖 Yahoo 目标季度就绪。旧版报告每次 Cron 最多自动升级两家公司；也可经授权的 `POST /company-analysis/{ticker}` 手动排队。公开 GET 只读，不触发生成。

## 验证与部署

在仓库根目录执行：

```sh
npm ci
npm run check:pipeline:boundary
npm run typecheck:pipeline
npm run test:pipeline
npm run worker:pipeline:check
npm run worker:pipeline:check:migrations
npm run worker:pipeline:deploy
```

`worker:pipeline:deploy` 先只读核对远端已应用 migrations，再以显式配置部署并保留运行时变量。
它不会自动执行数据库迁移。生成分析迁移使用 `npm run worker:pipeline:db:generate`；
根目录 `db:generate` / `db:migrate:remote` 仍属于投资账本。

保留生产 Worker 名、四个 Workflow 名、D1 ID、R2 bucket、Cron 和 Secrets。
不要用无 `--config` 的 Wrangler 命令部署 Pipeline，前端构建会生成自己的部署配置。

Cloudflare Builds 的切换配置、验证和回滚见 [迁移说明](../../docs/pipeline-migration.md)。
原 API 契约和设计背景见 [来源文档](https://github.com/Paikchu/earning-report-analysis/blob/7dba791f18bf9740924bbbba6efbf4c3a202f382/docs/analysis-backend.md)。
