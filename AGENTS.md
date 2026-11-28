# Spontra 开发规范（AGENTS.md）

## 1. 核心原则

- **第一性原理与克制变更**：从第一性原理出发解决问题，直击根源，主动完善需求。不可以做任何超出用户需求的事情。
- **AI Native**：不得进行过度的防御性编程，请以 AI Native 为基准，尽可能通过控制模型与 harness 来实现。
- **验证方式**：不要编写任何单元测试，直接模拟真实用户的操作来验证功能；验证应聚焦本次要验证的问题。
- **UI 与舞台渲染**：
  - 不得生成任何像 LLM 生成的 UI 前端和代码。
  - Sider 由固定代码编写，页面剩余的舞台部分全部由 Agent 进行页面渲染，通过 harness 控制页面渲染的效果、组件分布等。
  - 开发任务中，生成或修改页面时：不要附带解释段，只生成页面内容。
- **架构图与报告质检**：
  - 如果做了功能上的改动，必须检查是否需要同步调整架构图（`architecture.html`）。
  - 完成报告优化相关的任务后，必须按照测评指引文档（`docs/filing-analysis-eval-guide.md`）中的指示，对生成的文章进行 AI 金融分析师质检评估，并输出评分与负反馈建议。

---

## 2. 仓库架构与目录约定

本仓库只构建与部署 **1 个 Cloudflare Worker（`spontra-analysis`）**，由根目录 `wrangler.jsonc` 统一管理（同时托管 API、Cron/Queues/Durable Objects 与 `dist/` 静态资源）。iOS 客户端在独立仓库 `SpontraApp` 维护。

```text
wrangler.jsonc        唯一的 Worker 配置（spontra-analysis）
vite.config.ts        统一构建 web/ 到 dist/
migrations/           D1 数据库迁移 SQL（按编号顺序追加）
src/
  index.ts / worker.ts  唯一 Worker 入口与路由分发
  api/public/         面向 iOS 的只读 API（/api/business/v1/*）与签名预览宿主
  api/admin/          运维后台 API（/api/admin/*）与 Cloudflare Access JWT 校验
  pipeline/           事件驱动流水线（任务注册、事件路由、队列消费、定时发现）
  domains/            8 个垂直业务域（sec-archive / filing-material / financials /
                      filing-analysis / business-map / valuation / public-research / publishing）
  ai/                 Pi 运行时、TaskRunner DO、工具循环与模型调用底座
  lib/                无业务耦合的通用工具与基础类型
web/
  admin/              运维后台 React SPA
  preview/            签名报告预览壳与沙箱 iframe（/artifact-frame）
  shared/             后台与预览共用的 UI、i18n、样式与字体
  public/             静态资产（spontra-ios 隐私支持页、theme.js、_headers）
scripts/
  checks/             构建与 CI 边界/i18n/迁移检查脚本
  acceptance/         SEC 材料与报告验收脚本
docs/                 架构说明、设计文档与运维指引
```

---

## 3. 代码与边界规范

- **前后端边界**（由 `npm run check:boundary` 强制校验）：
  - `src/` 禁止引用 `web/`。
  - `web/` 引用 `src/` 时，仅允许 `import type` 或白名单中的纯浏览器契约。
- **业务域与数据源边界**：
  - 按业务领域放入 `src/domains/<domain>/`，不另设独立的顶层 `contracts/` 目录，类型契约内聚在所属模块内按需导出。
  - `src/domains/sec-archive/` 是唯一允许访问 EDGAR 的模块；其他业务域只能从 D1/R2 归档读取数据。
  - 新增静态文案或 issuer 相关逻辑需符合 `check:i18n` 与 `check:issuer-literals` 规则。
- **配置与安全**：
  - 禁止在代码或 `wrangler.jsonc` 中硬编码公司列表（统一以 D1 后台白名单与功能开关为准）。
  - 禁止提交真实密钥；本地环境变量参考 `.dev.vars.example`，真实 `.dev.vars*` 仅保留在本地。
  - `wrangler.jsonc` 中的 Durable Object `migrations` 不可回滚，禁止随意重命名或删除已有类迁移记录。

---

## 4. 数据库迁移规范（D1）

- 所有 D1 表结构变更必须在 `migrations/` 目录下按序号新增 `.sql` 文件，**禁止修改已上线执行过的历史迁移文件**。
- 线上迁移由 CI 部署命令 `npm run deploy` 自动执行（`migrate:ci` → `check:migrations` → `wrangler deploy`），无需手动操作线上数据库结构。

---

## 5. 本地开发、检查与发布流程

- **运行环境**：Node.js `>= 22.13.0`。
- **常用命令**：
  ```bash
  npm run dev          # 启动本地单 Worker（wrangler dev）
  npm run dev:web      # 启动 Vite 前端开发服务（代理 /api 到 127.0.0.1:8787）
  npm run check        # 全量检查：i18n / issuer-literals / boundary / typecheck / build / deploy:dry-run
  npm run lint         # ESLint 检查
  ```
- **提交与上线**：
  - 提交前必须通过 `npm run check`。
  - **唯一上线方式是推送 `origin/main`**，由 GitHub → Cloudflare Workers Builds 自动执行 `npm run check` 与 `npm run deploy`；**禁止本地手动部署线上**。
  - **提交完代码到 `origin/main` 后，必须同步本地 `main` 分支的代码与线上（`origin/main`）一致**。
  - 发布完成后确认 Cloudflare 构建日志正常，并验证线上 `/health`、`/ready` 及核心接口读取无异常。
