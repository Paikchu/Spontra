# Spontra 个股业务地图

基于公开财报的个股业务地图：从公司业务、产品与客户，到收入、成本费用与净利润。

- GitHub：[Paikchu/Spontra](https://github.com/Paikchu/Spontra)，主分支 `main`，唯一 remote 为 `origin`。
- 线上地图：`spontra-business-map` Worker。

## 三个 Worker，一个仓库

| Worker | 职责 | 配置 |
| --- | --- | --- |
| `spontra-business-map` | 公开业务地图页面与只读 API（`/api/business/v1/*`） | [`apps/business-site/wrangler.jsonc`](apps/business-site/wrangler.jsonc) |
| `spontra-admin` | 财报与业务地图运维后台 | [`apps/admin/wrangler.jsonc`](apps/admin/wrangler.jsonc) |
| `spontra-analysis` | SEC 发现与分析、业务解读、指引、发现、事件、基本面及分析读取 API | [`workers/pipeline/wrangler.jsonc`](workers/pipeline/wrangler.jsonc) |

数据边界：

- 地图通过 Service Binding `EARNING_REPORT_PIPELINE → spontra-analysis` 的 `MapReads` 命名入口读取数据。命名入口无法从公网访问，绑定本身即凭据，地图不保存读取密钥。
- admin 通过同名绑定访问 Pipeline 的默认入口，控制类路由由 `SEC_REFRESH_KEY` 保护。
- 分析 D1 `earning-report-analysis-sec-web` 与 R2 `earning-report-analysis-sec-filings` 归 Pipeline 所有，迁移文件在 `workers/pipeline/migrations/`。

## 目录结构

```text
apps/business-site/          业务地图前端（Vite + React）与 Worker
apps/admin/                  运维后台前端与 Worker
packages/web/                地图与后台共用的界面：财报阅读器、桑基图、shadcn 组件、样式与字体
shared/analysis-contract/    前端与 Pipeline 共用的声明式契约
shared/analysis-runtime/     前端与 Pipeline 共用的纯运行时（仅依赖 zod）
workers/pipeline/            财报分析 Worker、数据库 schema 与 migrations
tests/                       地图、后台与共享运行时测试
  pipeline/                  Pipeline 测试及合成数据
docs/                        功能、数据与运维说明
```

`scripts/check-pipeline-boundary.ts` 约束依赖方向：Pipeline 只依赖自身、共享契约与共享运行时；地图、后台和 `packages/web` 不得导入 Pipeline 源码。

## 本地开发

需要 Node.js **22.13 或更高版本**。

```bash
npm ci
npm run dev          # 地图，127.0.0.1:4188，/api 代理到 BUSINESS_SITE_API 或 127.0.0.1:8788
npm run admin:dev    # 后台，127.0.0.1:4190
npx wrangler dev --config workers/pipeline/wrangler.jsonc
```

Pipeline 配置模板见 [`workers/pipeline/.dev.vars.example`](workers/pipeline/.dev.vars.example)。真实 `.dev.vars*` 由 Git 忽略。

## 检查命令

```bash
npm run typecheck
npm run business-site:typecheck
npm run admin:typecheck
npm run test:unit
npm run build

npm run check:pipeline:boundary
npm run typecheck:pipeline
npm run test:pipeline
npm run worker:pipeline:check
```

`*:check` 是部署 dry-run，不代表已发布。

## GitHub → Cloudflare 自动部署

唯一上线方式是推送 `origin/main`，禁止本地手动部署。推送触发两条独立构建，根目录均为 `/`：

| 构建目标 | Build command | Deploy command |
| --- | --- | --- |
| 地图与后台 | `npm run build` | `npm run deploy:cloudflare` |
| Pipeline | `npm run check:pipeline:boundary && npm run typecheck:pipeline && npm run worker:pipeline:check` | `npm run worker:pipeline:deploy` |

`deploy:cloudflare` 先做类型检查、单元测试与构建，再依次发布 `spontra-admin` 和 `spontra-business-map`。第一条构建仍挂在 Cloudflare 上原 `spontra-app` Worker 的 Builds 设置下；删除该 Worker 前，需先把 Git 构建连接迁到 `spontra-business-map`。

Pipeline 部署先应用并核对分析 D1 迁移，再发布 Worker。发布完成后需确认两条构建结果及线上读取，不能仅凭 push 或 dry-run 判断上线成功。

## 相关说明

- [财报 Pipeline](workers/pipeline/README.md)
- [业务地图](apps/business-site/README.md)
- [财报管理后台](docs/report-admin.md)
- [发现与事件](docs/findings-events-design.md)
- [业绩指引](docs/guidance.md)
