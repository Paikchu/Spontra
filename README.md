# Spontra

**深入挖掘一家公司的各个方面，让用户理解公司的全貌。**

Spontra 是一个以 Discovery Agent 为核心的公司基本面研究平台。用户选择一家公司，Agent 从原始资料出发，自主发现值得追问的问题、调用工具、交叉核验并继续深入，将分散在财报、电话会、公司公告和外部资料中的信息，组织成有证据、可追溯、持续更新的公司研究。

研究不止于单份财报摘要或预设指标。Spontra 希望回答：这家公司如何创造价值，增长依赖什么，竞争优势是否成立，财务表现与经营现实是否一致，还有哪些重要问题尚未得到解释。

iOS 客户端在 [SpontraApp](https://github.com/Paikchu/SpontraApp) 仓库独立维护。

## 产品方向

### 从公司全貌出发

覆盖面用于建立对公司的整体理解，深入方向由材料中的发现决定。不同公司有不同的关键变量，不用固定研报目录替代调查。

| 研究方面 | 需要理解的问题 |
| --- | --- |
| 商业模式与业务结构 | 产品与服务、客户、收入来源、成本结构，以及价值如何转化为利润和现金 |
| 行业与竞争 | 市场空间、产业链、供需周期、替代方案、竞争对手与护城河 |
| 经营与增长 | 增长驱动、客户采用、订单、产能、项目进度及关键经营指标 |
| 财务质量与资本结构 | 收入与利润质量、现金流、资本开支、债务、融资和股东稀释 |
| 管理层与治理 | 战略、资本配置、激励、执行记录，以及承诺与实际结果的差异 |
| 风险、预期与估值 | 关键依赖、反证、情景假设、估值隐含预期及需要继续验证的条件 |

“公司全貌”是研究目标，不代表信息已穷尽。报告应明确已覆盖的资料、证据时点、缺口与未解决问题，区分事实、管理层表述、分析推断和情景假设。

### Discovery Agent：让发现驱动研究

用户无需预先知道所有关键问题。Agent 先建立公司基本图景，再从异常、矛盾、变化和缺失信息中形成调查方向；随着新证据出现，调整研究重点，而不是只按模板提取数据。

1. **建立图景**：了解业务结构，定位可用资料与关键经营变量。
2. **发现问题**：识别跨季度变化、口径差异、经营与财务之间的矛盾，以及需要验证的解释。
3. **深入调查**：自主选择资料与工具，查原文、取数据、计算、比较，并主动寻找反证。
4. **形成研究**：将发现连接成解释，保留引用、计算依据、分歧与未知。
5. **接续更新**：新披露或用户追问到来后，延续已有研究，修订相关结论并记录变化。

这些是研究行为，不是必须顺序执行的固定工作流。目标架构由 Agent 在 harness 内自主完成工具调用与分析循环；harness 提供工具、上下文管理、任务状态与执行边界，不用预设 Workflows 决定每一步调查路径。研究上下文应保留问题、证据与阶段成果，使有限上下文中的调查能够接续。

### 固定 Sider + Agent 渲染的研究舞台

**Sider 是用户与 Agent 的统一交互入口，页面其余空间全部用于展示研究。**

- **Sider 由固定代码编写**：承载公司选择、研究请求、追问、补充材料、方向调整与任务进度。用户在同一入口控制研究，不以中央聊天记录作为主要阅读界面。
- **舞台由 Agent 渲染**：Agent 根据研究内容决定页面结构、组件分布、阅读顺序与表达方式，通过 harness 控制渲染效果。舞台整体不由固定代码预先排成统一仪表盘；可复用组件作为表达工具，由 Agent 组织。
- **交互连接研究**：用户在舞台查看图表、展开证据或选择研究对象；需要进一步调查时，将对应上下文带回 Sider，由 Agent 接续处理。

舞台承载 **Live Report**：同一份公司研究随调查推进逐步形成，并在新证据出现后更新。文字、表格、趋势图、业务关系图和情景比较服务于具体问题；每个重要结论都应能回到来源，更新时说明哪些事实、假设或判断发生了变化。Live Report 的价值在于研究可继续、证据可核验，动画与流式输出只是表达手段。

### 保留研究积累

财报分析和持续跟踪是已有基础。长期积累的核心是公司知识、证据、研究问题和判断修订记录。

## 定位与实现边界

以上定义产品目标。目前 Web 端业务地图与搜索页面已全部下线，前端仅保留独立维护的 [SpontraApp](https://github.com/Paikchu/SpontraApp)（iOS 客户端）；本仓库聚焦于 **Spontra Analysis 后端分析引擎**、**运维后台（Admin）** 与**面向 iOS 的无头只读 API 网关及签名预览宿主**。

- GitHub：[Paikchu/Spontra](https://github.com/Paikchu/Spontra)，主分支 `main`，唯一 remote 为 `origin`。
- 线上只读网关：`spontra-business-map` Worker（无公开网页，仅提供 `/api/business/v1/*` 与签名 `/article-preview`）。

## 架构：单 Worker（`spontra-analysis`）

整个仓库只构建与部署 **1 个 Cloudflare Worker（`spontra-analysis`）**，由根目录 [`wrangler.jsonc`](wrangler.jsonc) 统一管理，前端仅保留独立维护的 [SpontraApp](https://github.com/Paikchu/SpontraApp)（iOS 客户端）。

| 模块 | 职责 | 位置 |
| --- | --- | --- |
| 唯一 Worker 入口 | 请求路由、Cron 发现（`*/10`）、Queues 调度、`TaskRunner` DO | [`src/index.ts`](src/index.ts) / [`src/worker.ts`](src/worker.ts) |
| 公开只读 API 与预览宿主 | iOS 只读接口（`/api/business/v1/*`）、限流与 Edge Cache、签名报告预览（`/article-preview`、`/artifact-frame`） | [`src/api/public/`](src/api/public/) |
| 运维后台 API 与鉴权 | `/api/admin/*`（Cloudflare Access JWT 校验）与后台接口实现 | [`src/api/admin/`](src/api/admin/) |
| 事件驱动流水线 | 事件路由、任务注册表、防抖/沉降调度 | [`src/pipeline/`](src/pipeline/) |
| 业务域（8 个垂直切片） | SEC 归档、财报材料、财务数据、财报分析、业务拆解、估值、公开研究、产物渲染与翻译 | [`src/domains/`](src/domains/) |
| AI 与 Agent 底座 | Pi 运行时、`TaskRunner` DO、工具循环、网页搜索、独立评审 | [`src/ai/`](src/ai/) |
| 内部前端静态资源 | 运维后台 SPA（`web/admin`）、签名预览壳（`web/preview`）、公共静态页（`web/public/spontra-ios`） | [`web/`](web/) |
| D1 迁移与运维脚本 | D1 迁移 SQL、架构边界/i18n/迁移检查与验收脚本 | [`migrations/`](migrations/)、[`scripts/`](scripts/) |

数据与权限边界：

- D1 `earning-report-analysis-sec-web` 与 R2 `earning-report-analysis-sec-filings` 由 `spontra-analysis` 独占，迁移文件位于 [`migrations/`](migrations/)。
- `src/domains/sec-archive/` 是唯一访问 EDGAR 的模块；其余业务域仅从 D1/R2 归档读取。
- `scripts/checks/check-analysis-boundary.ts` 约束前后端分离：`src/` 不得引用 `web/`；`web/` 从 `src/` 引用时仅允许 `import type` 或白名单中的纯浏览器契约。
- `spontra-analysis` 同时保留 `MapReads` 与 `AdminGateway` 具名入口以兼容存量 Service Binding 过渡；线上将 `businessview.info` 等路由直接指向 `spontra-analysis` 后即可下线旧的 `spontra-business-map` 与 `spontra-admin` Worker。

## 目录结构

```text
wrangler.jsonc               唯一的 Cloudflare Worker 配置（spontra-analysis）
vite.config.ts               统一构建 web/admin、web/preview、web/artifact-frame 到 dist/
migrations/                  D1 数据库迁移 SQL
src/
  api/public/                iOS 只读 API 网关、Edge Cache 与签名预览路由
  api/admin/                 运维后台 API、Cloudflare Access 校验与后台接口
  pipeline/                  事件驱动调度（registry / router / consumer / discovery）
  domains/                   8 个垂直业务域（sec-archive / filing-material / financials /
                             filing-analysis / business-map / valuation / public-research / publishing）
  ai/                        Pi 运行时、Durable Runs、工具与模型调用底座
  lib/                       通用工具与基础类型
web/
  admin/                     运维后台 React SPA
  preview/                   签名报告预览壳与沙箱 iframe（/artifact-frame）
  shared/                    后台与预览共用的 UI、i18n、样式与字体
  public/                    静态资产（spontra-ios 隐私支持页、theme.js、_headers）
scripts/
  checks/                    构建与 CI 校验（边界、i18n、issuer 字面量、D1 迁移、PDF.js 准备）
  acceptance/                SEC 材料与报告验收脚本及本地配置
docs/                        架构说明、设计文档与运维指引
```

## 本地开发

需要 Node.js **22.13 或更高版本**。

```bash
npm ci
npm run build        # 构建 web/ 到 dist/ 并准备 PDF.js 静态资产
npm run dev          # 启动本地单 Worker（wrangler dev --config wrangler.jsonc）
npm run dev:web      # 仅启动 Vite 前端开发服务器（127.0.0.1:4190，/api 代理到 127.0.0.1:8787）
```

环境变量模板见 [`.dev.vars.example`](.dev.vars.example)。真实 `.dev.vars*` 由 Git 忽略。

## 检查命令

```bash
npm run check        # 依次执行 check:i18n、check:issuer-literals、check:boundary、typecheck、build、deploy:dry-run
npm run lint
```

`npm run deploy:dry-run` 是部署 dry-run，不代表已发布。

## GitHub → Cloudflare 自动部署

唯一上线方式是推送 `origin/main`，禁止本地手动部署。根目录为 `/`：

| 构建目标 | Build command | Deploy command |
| --- | --- | --- |
| Spontra Analysis（单 Worker） | `npm run check` | `npm run deploy` |

`npm run deploy` 先应用并核对 D1 迁移（[`migrations/`](migrations/)），再将构建好的 `dist/` 静态资产与 Worker 源码一并发布到 `spontra-analysis`。发布完成后需确认构建日志及线上读取（`/health`、`/ready`、`/api/business/v1/home`）。

## 相关说明

- [五层分析架构](docs/spontra-analysis-architecture.md)
- [财务数据与三表](docs/financial-data.md)
- [SEC 归档](docs/sec-archive.md)
- [BusinessView 后台](docs/businessview-admin.md)
