# Spontra

**深入挖掘一家公司的各个方面，让用户理解公司的全貌。**

Spontra 是一个以 Discovery Agent 为核心的公司基本面研究平台。用户选择一家公司，Agent 从原始资料出发，自主发现值得追问的问题、调用工具、交叉核验并继续深入，将分散在财报、电话会、公司公告和外部资料中的信息，组织成有证据、可追溯、持续更新的公司研究。

研究不止于单份财报摘要或预设指标。Spontra 希望回答：这家公司如何创造价值，增长依赖什么，竞争优势是否成立，财务表现与经营现实是否一致，还有哪些重要问题尚未得到解释。

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

以上定义产品目标，不代表完整的 Discovery Agent、Live Report 与 Agent 自主布局已经实现。本仓库提供公司研究数据、分析服务、业务地图与后台；具体职责及部署方式见下文。现有能力应逐项验证，不能将定时分析或报告展示等同于完整的自主研究闭环。

- GitHub：[Paikchu/Spontra](https://github.com/Paikchu/Spontra)，主分支 `main`，唯一 remote 为 `origin`。
- 线上地图：`spontra-business-map` Worker。

## 架构

| 层 | 是什么 | 位置 |
| --- | --- | --- |
| 后端 | **Spontra Analysis**：SEC 发现与解析、AI 分析、读取 API | 本仓库 `workers/analysis/`，Worker `spontra-analysis` |
| 业务地图与后台 | 公开业务地图与运维后台，经 Service Binding 读 Spontra Analysis | 本仓库 `apps/business-site/`、`apps/admin/` |

## 三个 Worker，一个仓库

| Worker | 职责 | 配置 |
| --- | --- | --- |
| `spontra-business-map` | 公开业务地图页面与只读 API（`/api/business/v1/*`） | [`apps/business-site/wrangler.jsonc`](apps/business-site/wrangler.jsonc) |
| `spontra-admin` | 财报与业务地图运维后台 | [`apps/admin/wrangler.jsonc`](apps/admin/wrangler.jsonc) |
| `spontra-analysis` | SEC 发现与归档、财务采集、全部 AI 分析（要点、业务解读、脑图、估值、舞台等）、事件、基本面及读取 API | [`workers/analysis/wrangler.jsonc`](workers/analysis/wrangler.jsonc) |

数据边界：

- 地图通过 Service Binding `SPONTRA_ANALYSIS → spontra-analysis` 的 `MapReads` 命名入口读取数据。命名入口无法从公网访问，绑定本身即凭据，地图不保存读取密钥。
- admin 通过同名绑定访问 Spontra Analysis 的 `AdminGateway` 命名入口，每次请求带新的后台会话；舞台经地图的 `SPONTRA_STAGE → StageGateway` 绑定进入。
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
- [SEC 归档](docs/sec-archive.md)
