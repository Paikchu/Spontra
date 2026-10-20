# Spontra 个股业务地图

基于公开财报的个股业务地图：从公司业务、产品与客户，到收入、成本费用与净利润。

- GitHub：[Paikchu/Spontra](https://github.com/Paikchu/Spontra)，主分支 `main`，唯一 remote 为 `origin`。
- 线上地图：`spontra-business-map` Worker。

## 架构

| 层 | 是什么 | 位置 |
| --- | --- | --- |
| 前端 | 基于 DeepSeek Harness 的投资研究应用（Harness 客户端 + `investment` 组合包） | `deepseek-harness` 仓库：`packages/bundle/investment`、`packages/client/ui-investment`、`packages/api/investment-controller` |
| 后端 | **Spontra Analysis**：SEC 发现与解析、AI 分析、读取 API | 本仓库 `workers/analysis/`，Worker `spontra-analysis` |
| 业务地图与后台 | 公开业务地图与运维后台，经 Service Binding 读 Spontra Analysis | 本仓库 `apps/business-site/`、`apps/admin/` |

前端代码只在 `deepseek-harness` 仓库开发与发布，本仓库不放 Harness 前端源码；两边只通过 Spontra Analysis 的读取 API 与共享契约（`shared/analysis-contract/`）对接。

## 三个 Worker，一个仓库

| Worker | 职责 | 配置 |
| --- | --- | --- |
| `spontra-business-map` | 公开业务地图页面与只读 API（`/api/business/v1/*`） | [`apps/business-site/wrangler.jsonc`](apps/business-site/wrangler.jsonc) |
| `spontra-admin` | 财报与业务地图运维后台 | [`apps/admin/wrangler.jsonc`](apps/admin/wrangler.jsonc) |
| `spontra-analysis` | SEC 发现与分析、业务解读、指引、发现、事件、基本面及分析读取 API | [`workers/analysis/wrangler.jsonc`](workers/analysis/wrangler.jsonc) |

数据边界：

- 地图通过 Service Binding `SPONTRA_ANALYSIS → spontra-analysis` 的 `MapReads` 命名入口读取数据。命名入口无法从公网访问，绑定本身即凭据，地图不保存读取密钥。
- admin 通过同名绑定访问 Spontra Analysis 的默认入口，控制类路由由 `SEC_REFRESH_KEY` 保护。
- 分析 D1 `earning-report-analysis-sec-web` 与 R2 `earning-report-analysis-sec-filings` 归 Spontra Analysis 所有，迁移文件在 `workers/analysis/migrations/`。

## 目录结构

```text
apps/business-site/          业务地图前端（Vite + React）与 Worker
apps/admin/                  运维后台前端与 Worker
packages/web/                地图与后台共用的界面：财报阅读器、桑基图、shadcn 组件、样式与字体
shared/analysis-contract/    前端与 Spontra Analysis 共用的声明式契约
shared/analysis-runtime/     前端与 Spontra Analysis 共用的纯运行时（仅依赖 zod）
workers/analysis/            财报分析 Worker、数据库 schema 与 migrations
docs/                        功能、数据与运维说明
```

`scripts/check-analysis-boundary.ts` 约束依赖方向：Spontra Analysis 只依赖自身、共享契约与共享运行时；地图、后台和 `packages/web` 不得导入 Spontra Analysis 源码。

## 本地开发

需要 Node.js **22.13 或更高版本**。

```bash
npm ci
npm run dev          # 地图，127.0.0.1:4188，/api 代理到 BUSINESS_SITE_API 或 127.0.0.1:8788
npm run admin:dev    # 后台，127.0.0.1:4190
npx wrangler dev --config workers/analysis/wrangler.jsonc
```

Spontra Analysis 配置模板见 [`workers/analysis/.dev.vars.example`](workers/analysis/.dev.vars.example)。真实 `.dev.vars*` 由 Git 忽略。

## 检查命令

```bash
npm run typecheck
npm run business-site:typecheck
npm run admin:typecheck
npm run build

npm run check:analysis:boundary
npm run analysis:typecheck
npm run analysis:check
```

`*:check` 是部署 dry-run，不代表已发布。

## GitHub → Cloudflare 自动部署

唯一上线方式是推送 `origin/main`，禁止本地手动部署。推送触发两条独立构建，根目录均为 `/`：

| 构建目标 | Build command | Deploy command |
| --- | --- | --- |
| 地图与后台 | `npm run build` | `npm run deploy:cloudflare` |
| Spontra Analysis | `npm run check:analysis:boundary && npm run analysis:typecheck && npm run analysis:check` | `npm run analysis:deploy` |

`deploy:cloudflare` 先做类型检查与构建，再依次发布 `spontra-admin` 和 `spontra-business-map`。这条构建挂在 `spontra-business-map` Worker 的 Builds 设置下（原 `spontra-app` Worker 已删除），部署脚本会清掉 Workers Builds 注入的 Worker 名，两个应用各按自己的配置名发布。

Spontra Analysis 部署先应用并核对分析 D1 迁移，再发布 Worker。发布完成后需确认两条构建结果及线上读取，不能仅凭 push 或 dry-run 判断上线成功。

## 相关说明

- [Spontra Analysis](workers/analysis/README.md)
- [业务地图](apps/business-site/README.md)
- [BusinessView 后台](docs/businessview-admin.md)
- [发现与事件](docs/findings-events-design.md)
- [业绩指引](docs/guidance.md)
