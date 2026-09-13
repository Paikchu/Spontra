# MAX · 投资记录

投资组合与投资研究应用：查看 IBKR 持仓、成交和净入金，维护持仓计划，跟踪财报日历，并读取 SEC 财报、公司业务前瞻与基本面指标。

前端基于 React、Vinext、Tailwind CSS 和 shadcn 风格组件；后端运行在 Cloudflare Workers，使用 D1、R2 和 Workflows。

## 项目目标

蒸馏个人股票投资思想，自动化维护并持续完善基本面投资逻辑，逐步实现 AI 24 小时实时盯盘。

- **蒸馏个人投资思想**：从研究笔记、持仓计划、交易记录与复盘中提炼个人的选股标准、判断依据和决策原则，形成可追溯、可迭代的投资框架。
- **自动维护基本面投资逻辑**：持续跟踪财报、公司公告、经营数据与行业变化，用新证据检验投资假设，更新支持依据、风险与失效条件，完善每只股票的投资逻辑。
- **AI 24 小时实时盯盘**：持续关注行情、重要事件及基本面变化，结合个人持仓与投资逻辑识别值得关注的信号，及时提醒并说明影响。

以上是项目的长期建设目标；当前已实现的功能、数据更新频率和运行边界以下文为准。

## 项目入口

- GitHub：[Paikchu/investment-record](https://github.com/Paikchu/investment-record)，主分支 `main`。
- 生产网站：[MAX · 投资记录](https://investment-record.max-zhangyuchen.workers.dev/)。
- 当前本地目录：`/Users/max/Investment/investment-record`。
- 唯一 Git remote：`origin` 指向 `https://github.com/Paikchu/investment-record.git`，发布统一使用 `git push origin main`。

GitHub 是唯一维护与自动部署的主仓库。`earning-report-analysis` 原仓库保留历史代码与旧 Web 入口，财报 Pipeline 的后续维护在本仓库进行。

## 三个 Worker，一个仓库

| Worker | 当前职责 | 配置 | 自动发布 |
| --- | --- | --- | --- |
| `investment-record` | 页面、投资账本 API、财报分析读取代理 | [`wrangler.jsonc`](wrangler.jsonc) | 前端 Git 构建 |
| `max-investment-record-sec-cron` | IBKR 定时同步、财报日历刷新 | [`workers/sec-cron/wrangler.jsonc`](workers/sec-cron/wrangler.jsonc) | 前端部署命令的最后一步 |
| `earning-report-analysis-sec-pipeline` | SEC 发现与分析、Memory、公司分析、基本面及分析读取 API | [`workers/pipeline/wrangler.jsonc`](workers/pipeline/wrangler.jsonc) | 独立 Pipeline Git 构建 |

`sec-cron` 的代码已经在本仓库。它不需要单独连接 GitHub，Cloudflare Builds 页面显示未独立连接是预期状态。名称中的 `sec` 来自历史用途，历史 SEC 分析执行代码已退役，仅运行投资数据任务。

### 数据与调用边界

- **投资账本 D1**：`investment-record-db`，由主应用的 `DB` 绑定访问；迁移文件在 `drizzle/`。
- **财报分析 D1**：`earning-report-analysis-sec-web`，由 Pipeline 的 `DB` 绑定访问；迁移文件在 `workers/pipeline/migrations/`。数据库沿用历史名称，所有权属于 Pipeline。
- **财报分析 R2**：`earning-report-analysis-sec-filings`，保存 Pipeline 的原文与分析产物。
- **历史 SEC R2**：`max-investment-record-sec-filings` 数据保留，已解除 `sec-cron` 绑定；本次清理不删除历史资源。
- 主应用通过 `EARNING_REPORT_PIPELINE → earning-report-analysis-sec-pipeline` Service Binding 读取分析结果；本地或其他消费者可使用服务端 HTTPS。
- 定时任务通过指向 `investment-record` 的 Service Binding 更新账本和财报日历。`PORTFOLIO_SERVICE` 是本地清理后的目标名称；重命名代码尚未提交，当前发布配置以 `workers/sec-cron/wrangler.jsonc` 为准。
- Pipeline 拥有四个分析 Workflows；`sec-cron` 不再注册或启动历史 SEC Workflows。

分析读取凭据只在服务端使用。读取已发布报告不启动 SEC/Yahoo 抓取、AI 分析或数据库写入。投资账本与分析数据库的迁移命令必须分别执行。

## 目录结构

```text
app/                         页面、API 与交互组件
  portfolio/                 组合概览、分布图与持仓账本组件
  positions/[ticker]/        个股详情、业务前瞻、财务指标和持仓计划
  analysis/                  财报搜索、报告页面和分析组件
  api/analysis/v1/           面向浏览器的分析读取代理
worker/                      主应用 Cloudflare 入口
lib/                         投资账本、IBKR、行情与服务端逻辑
  earning-report/            分析前端客户端与展示工具
shared/analysis-contract/    前端与 Pipeline 共用的分析契约、指标展示元数据
workers/
  sec-cron/                  IBKR 与财报日历定时 Worker
  pipeline/                  财报分析 Worker、数据库 schema 与 migrations
drizzle/                     投资账本数据库迁移
tests/                       投资业务与前端分析接入测试
  pipeline/                  财报后端测试及合成数据
data/                        本地数据快照与证券目录
docs/                        功能、迁移与运维说明
```

## 本地开发

需要 Node.js **22.13 或更高版本**，依赖版本以 `package-lock.json` 为准。

```bash
cd /Users/max/Investment/investment-record
npm ci
npm run dev
```

单独启动 Pipeline：

```bash
npx wrangler dev --config workers/pipeline/wrangler.jsonc
```

本地启动不会自动获得线上 Secrets 或生产数据。配置模板见 [`.env.example`](.env.example) 和 [`workers/pipeline/.dev.vars.example`](workers/pipeline/.dev.vars.example)。根据要调试的功能提供配置，真实 `.env*` / `.dev.vars*` 文件由 Git 忽略，不应提交。

### 主要运行时配置

| Worker | 关键变量与 Secrets |
| --- | --- |
| 主应用 | `PORTFOLIO_SYNC_KEY`、`EARNING_REPORT_READ_TOKEN`；使用 HTTPS 时配置 `EARNING_REPORT_PIPELINE_ORIGIN` |
| `sec-cron` | `IBKR_FLEX_QUERY_ID`、`IBKR_FLEX_TOKEN`、`PORTFOLIO_SYNC_KEY` |
| Pipeline | `SEC_USER_AGENT`、`SEC_TRACKED_TICKERS`、`SEC_ANALYSIS_MODEL`、`AI_API_KEY`、`SEC_REFRESH_KEY`、`ANALYSIS_READ_KEYS`、可选 `ANALYSIS_ADDITIONAL_READ_KEYS` |

主应用与 `sec-cron` 的 `PORTFOLIO_SYNC_KEY` 必须一致。前端的读取凭据必须匹配 Pipeline 配置的消费者凭据。生产值保留在对应 Worker 的 Runtime variables / Secrets 中，本地文件不会随部署自动上传。

当前持仓计划按 ticker 共享，所有访问者均可编辑，最后一次保存生效；保留同源检查和输入校验。历史记录保留，读取最近更新的记录。内部同步接口仍要求同步密钥。

## 检查命令

按改动范围运行相关检查；文档修改不需要重跑业务测试。

```bash
# 主应用
npm run build
npm run lint
npm run typecheck
npm test

# 分析前端与 Pipeline 的接入
npm run test:earning-report

# 财报 Pipeline
npm run check:pipeline:boundary
npm run typecheck:pipeline
npm run test:pipeline
npm run worker:pipeline:check

# 投资定时任务
npm run sec-cron:check
```

`npm test` 自动发现并运行主应用单元测试、Pipeline 测试，再构建并运行页面回归；单独调试可用 `test:unit` 和 `test:rendered`。历史宏观文件使用配对测试快照验证，不要求历史数据始终匹配最新账本。

`worker:pipeline:check` 和 `sec-cron:check` 是部署 dry-run，不代表已发布。需要验证主应用部署产物时，在 `npm run build` 后执行：

```bash
npx wrangler deploy --config dist/server/wrangler.json --keep-vars --dry-run
```

Cloudflare Vite 插件与 Wrangler 应保持兼容。当前分别固定为 `1.54.2` 和 `4.127.1`；更新工具链时，同时检查主应用生成配置和两个后台 Worker，避免只通过前端 build 却在部署阶段失败。

## GitHub → Cloudflare 自动部署

唯一上线方式是推送 `origin/main`，禁止本地手动部署。下表 Deploy command 仅由 Cloudflare 自动构建执行，不在本地运行。推送会触发两条独立构建，根目录均为 `/`：

| 构建目标 | Build command | Deploy command |
| --- | --- | --- |
| 主应用及 `sec-cron` | `npm run build` | `npm run deploy:cloudflare` |
| Pipeline | `npm run check:pipeline:boundary && npm run typecheck:pipeline && npm run worker:pipeline:check` | `npm run worker:pipeline:deploy` |

主应用部署依次执行：投资账本 D1 迁移 → 主应用部署 → `sec-cron` 部署。Pipeline 部署先只读核对分析 D1 的迁移记录，再发布 Worker；**不会自动应用分析数据库迁移**。

```bash
# 完成验证并将本次修改提交到 main 后，通过推送触发自动部署
git push origin main
```

`sec-cron:deploy` 在子进程中移除 Builds 注入的主应用名称覆盖，并显式指定后台 Worker 名称。Pipeline 所有部署命令都显式指定自己的 Wrangler 配置，避免被前端生成的 `.wrangler/deploy/config.json` 引导到错误 Worker。

不要把根目录 `wrangler.jsonc` 的 `name` 改成 Pipeline 名称；根配置属于 `investment-record`。Cloudflare 连接向导对 monorepo 的自动修复建议需要核对实际部署命令。

发布完成应确认两条构建结果、实际线上版本及相关业务读取/任务执行，不能仅凭 Git push 或 dry-run 判断上线成功。

### 数据库迁移

```bash
# 投资账本：生成 / 应用生产迁移
npm run db:generate
npm run db:migrate:remote

# 财报分析：生成 / 只读核对生产迁移
npm run worker:pipeline:db:generate
npm run worker:pipeline:check:migrations

# 财报分析：需要升级 schema 时，单独应用生产迁移
npx wrangler d1 migrations apply earning-report-analysis-sec-web --remote --config workers/pipeline/wrangler.jsonc
```

本地迁移使用 `--local`。不要修改已应用的历史 SQL 文件，也不要混用投资账本和分析数据库的配置。

## 定时任务与数据更新

| Worker | Cron（UTC） | 北京时间 / 用途 |
| --- | --- | --- |
| `sec-cron` | `0 6 * * 2-6` | 周二至周六 14:00，IBKR Flex 同步 |
| `sec-cron` | `15 * * * *` | 每小时第 15 分钟，财报日历刷新 |
| Pipeline | `*/10 * * * *` | 全天每 10 分钟检查 SEC、Memory、公司分析及基本面 |

Pipeline 的高频计划在源码中标记为临时诊断调度，迁移时原样保留；恢复交易时段计划属于后续独立调整。基本面刷新每轮最多处理两只股票，复用抓取记录安排优先级；最近 30 分钟内已尝试的股票暂缓重试，让后续股票继续得到处理。

IBKR 同步使用只读 Flex 数据，校验后写入投资账本。相同内容返回 `unchanged`，同日更正可重新发布；并发写入会校验快照版本，冲突后重新读取并合并成交历史。持仓成本保留 Flex 的实际合约乘数和成本金额；空持仓只有在持仓报表章节存在且现金与净值对账通过时才接受。无效数据不会覆盖上一次有效快照。累计净入金必须覆盖首次入金，不能用最近一年的净入金代替累计本金。

财报日历保留来源与更新时间，区分确认日期和估计日期；刷新失败保留已有数据。实现说明见 [财报日历](docs/earnings-calendar-live.md)。

手动同步入口是 `sec-cron` 的 `POST /internal/portfolio/sync`，需要 `x-portfolio-sync-key`。使用安全的服务端工具传递凭据，不把密钥写入命令参数、文档或日志。

其他数据维护命令：

```bash
npm run snapshot:update -- --input /absolute/path/to/ibkr-export.json
npm run ibkr:flex:fetch -- --query-id 1628251 --output /absolute/path/to/ibkr-flex-input.json
npm run symbols:update
npm run earnings:update
npm run review:check
npm run macro:check
npm run market-close:build
npm run market-close:check
```

这些本地命令不等同于生产数据同步；执行前核对脚本的输入、输出与目标存储。

## 页面与接口

| 路径 | 用途 |
| --- | --- |
| `/` | 组合概览与投资账本；主界面支持在页面内切换内容 |
| `/positions/[ticker]` | 业务前瞻、财务指标、技术面、持仓构成、持仓计划及披露时间线 |
| `/analysis` | 财报搜索入口 |
| `/analysis/stocks/[ticker]` | 兼容旧链接，重定向到个股详情 |
| `/analysis/stocks/[ticker]/sec/[accession]` | 完整财报分析 |
| `/macro` | 宏观功能占位入口 |
| `/market-close` | 旧收盘简报链接，重定向首页 |
| `/settings` | 主题与语言设置 |
| `/positions/[ticker]/sec/[accession]` | 旧报告链接，重定向统一报告页面 |
| `/api/analysis/v1/*` | 主应用的分析读取代理，服务端附加读凭据 |
| `/api/internal/portfolio/sync` | 受同步密钥保护的账本同步接口 |
| `/api/internal/earnings/refresh` | 受同步密钥保护的财报日历刷新接口 |

Pipeline 自身提供 `/api/v1/companies/:ticker/filings`、`analysis`、`fundamentals` 等读取资源，接口约定见 [Pipeline 说明](workers/pipeline/README.md)。`/health` 检查存活，`/ready` 检查配置和绑定是否存在，不代表模型请求或全部历史任务都成功。

个股「财务指标」及公开 `fundamentals` 接口读取 SEC 文件的 XBRL 数据（`source: sec_xbrl`）。SEC 披露索引刷新时尝试更新 Company Facts 快照，即使索引未变化也会重试，以补齐延迟到达的数据；抓取失败或缺少季度营收时保留上次成功快照。已有 `sec_facts` 可在首次刷新前提供数据，不使用 Yahoo 补齐缺失指标。累计金额按同概念、同币种推导单季，第四季度使用全年减前九个月；EPS 不做累计相减。每个数值保留文件 accession、披露日期及推导公式，页面可见时每分钟重新读取。

## 在新对话中继续维护

1. 选择本地文件夹 `/Users/max/Investment/investment-record`。
2. 先检查 `git status`、当前分支及 `origin/main`，保留已有未提交修改。
3. 根据职责进入 `app/`、`workers/sec-cron/` 或 `workers/pipeline/`，当前项目统一从本仓库的 `origin/main` 自动发布。
4. 修改后台时核对对应 Wrangler 配置、Secrets 和数据库归属；读取凭据不要进入客户端。

相关说明：

- [投资定时 Worker](workers/sec-cron/README.md)
- [财报 Pipeline](workers/pipeline/README.md)
- [Pipeline 仓库迁移与回滚](docs/pipeline-migration.md)
- [分析前端迁移背景](docs/earning-report-frontend-migration.md)
- [财报日历刷新](docs/earnings-calendar-live.md)

迁移文档记录的是当时状态。当前代码以 GitHub `main` 为准，实际部署、资源与执行结果以 Cloudflare 为准。
