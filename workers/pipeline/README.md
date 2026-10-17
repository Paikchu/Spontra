# 财报分析 Pipeline

独立部署为 `spontra-analysis`，代码最初迁自 `Paikchu/earning-report-analysis`。

## 责任边界

- `src/`：SEC 发现、AI 分析、公司分析、Memory、Yahoo 基本面、地图读取接口和 Cron。
- `migrations/`：分析数据库的完整历史；文件名和内容与来源保持一致。
- `shared/analysis-contract/`（仓库根目录）：供分析后端使用的共享类型。
- 业务地图通过 `EARNING_REPORT_PIPELINE` Service Binding 的 `MapReads` 命名入口读取结果；admin 绑定默认入口。

个股「业务拆解」由公司分析 Workflow 在 SEC Memory 更新后生成。它读取最多四期已发布 SEC 报告、复用 Web Search 的 Claude 网页检索与网页读取，最多执行九次取证工具调用，完成逐段引用核查后发布到原公司分析读取 API；旧版「业务前瞻」仍可读取。生成只需模型密钥 `ANTHROPIC_API_KEY`，不依赖 Yahoo 目标季度就绪。旧版报告每次 Cron 最多自动升级两家公司；也可经授权的 `POST /company-analysis/{ticker}` 手动排队。公开 GET 只读，不触发生成。

业务脑图由 `BusinessTreeWorkflow`（`src/business-tree/`）生成：每项财报披露业务一轮 ReAct（think → search / read / add / revise / remove / finish），每个节点须引用把它归入上级的原文，再经独立审校后存入 `business-tree:v1:{ticker}`，读取接口 `/api/v1/companies/:t/business-tree` 只读 D1。公司名单为 `BUSINESS_TREE_TICKERS`，`BUSINESS_TREE_ENABLED=false` 暂停扫描。设计见 `docs/business-tree.md`。

## 验证与部署

在仓库根目录执行：

```sh
npm ci
npm run check:pipeline:boundary
npm run typecheck:pipeline
npm run worker:pipeline:check
npm run worker:pipeline:check:migrations
npm run worker:pipeline:deploy
```

`worker:pipeline:deploy` 先应用并核对远端 migrations，再以显式配置部署并保留运行时变量。
生成分析迁移使用 `npm run worker:pipeline:db:generate`。

保留生产 Worker 名、四个 Workflow 名、D1 ID、R2 bucket、Cron 和 Secrets。
不要用无 `--config` 的 Wrangler 命令部署 Pipeline，前端构建会生成自己的部署配置。

原 API 契约和设计背景见 [来源文档](https://github.com/Paikchu/earning-report-analysis/blob/7dba791f18bf9740924bbbba6efbf4c3a202f382/docs/analysis-backend.md)。
