# 工作原则

从第一性原理出发解决问题，直击根源，主动完善需求。验证应聚焦本次要验证的问题。

# 验证方式

本项目不写、不运行单元测试，也不用 mock、假对象或固定样本驱动的测试来判断功能是否可行。功能是否可靠，一律通过实际使用对应功能来确认：

- 业务地图、运维后台：启动或打开真实页面，按用户路径实际操作，核对渲染结果、接口响应和控制台错误。
- 桌面端：运行真实应用，在真实 webview 中操作（`apps/desktop/README.md` 的 selftest 与 perf 脚本属于此类）。
- Spontra Analysis：通过真实路由、事件或后台操作触发真实任务，核对运行状态与 D1、R2 中的产物。
- 类型检查、边界检查、构建只说明代码能编译和打包，不等于功能可用。
- 无法实际操作时，明确报告哪些功能未验证，不能用其他检查代替。

# 架构与命名

- 后端统一称 **Spontra Analysis**（目录 `workers/analysis/`，Worker `spontra-analysis`，npm 脚本前缀 `analysis:`，Service Binding `SPONTRA_ANALYSIS`，提交 scope `analysis`）。不再使用“Pipeline”称呼后端；队列 `spontra-pipeline-*`、D1 表 `pipeline_*` 与 `src/pipeline/`（事件与任务路由）是内部机制与已有资源名，保持不变。
- 前端是基于 DeepSeek Harness 的应用，源码在 `deepseek-harness` 仓库（`investment` 组合包），不放入本仓库。
- SEC 资料只有一个入口：`workers/analysis/src/sec-archive/` 读 EDGAR（见 `docs/sec-archive.md`）。其他模块、Workflow 与 Agent 一律从已归档的文件（D1 指针 + R2 原文、文件库）读取 SEC 原文，不直接下载、不经网页搜索抓取 sec.gov；构建的边界检查会拒绝越界代码。

# Git 与上线规则

- 本仓库唯一远程为 `origin`，fetch 和 push 均指向 `https://github.com/Paikchu/Spontra.git`。所有分支与 worktree 共用此远程，不添加其他发布远程。
- 唯一生产发布入口是 GitHub 的 `main` 分支。用户要求“上线”或“部署”时，将已验证的本次修改提交并合并到本地 `main`，执行 `git push origin main`，由 Cloudflare 自动部署。
- 禁止本地手动部署，包括 `wrangler deploy`、`wrangler versions upload/deploy`、`wrangler pages deploy`、直接调用部署 API，以及本地运行 `deploy:cloudflare`、`analysis:deploy` 等发布脚本。这些部署脚本仅供自动构建执行。自动部署失败时，修复后再次推送，不绕过自动部署。
- 用户只要求提交或合并时，不自动推送。用户要求上线时，推送已获授权，不重复请求确认。

## 发布步骤

1. 检查 `git status --short`、当前分支及 `git remote -v`，确认 `origin` 的 fetch/push 地址正确；执行 `git fetch origin --prune` 核对远程变化。
2. 只暂存本次任务修改，保留其他任务的未提交内容；同文件混有其他修改时按 hunk 暂存。不使用强制推送，不丢弃已有工作。
3. 执行类型检查及必要构建，按“验证方式”实际操作本次修改的功能，检查 `git diff --cached --check`，提交并安全合并到本地 `main`。
4. 执行 `git push origin main`。核对 `git rev-parse main` 与 `git ls-remote origin refs/heads/main` 的 SHA 一致。
5. 核验该提交对应的 Cloudflare 自动构建与线上功能。若无法获取构建状态，明确报告“已推送，自动部署结果未核验”，不能把推送成功当作上线成功。

## 自动部署目标

推送 `origin/main` 触发两个独立构建，根目录均为 `/`：

- 业务地图 `spontra-business-map` 与运维后台 `spontra-admin`：构建 `npm run build`，CI 执行 `npm run deploy:cloudflare`。该构建挂在 `spontra-business-map` Worker 的 Builds 设置下（原 `spontra-app` Worker 已删除）。
- Spontra Analysis：构建 `npm run check:analysis:boundary && npm run analysis:typecheck && npm run analysis:check`，CI 执行 `npm run analysis:deploy`。

桌面端 `apps/desktop`（Tauri 2）不在这两个目标内：安装包由 GitHub Actions 在 tag `desktop-v*` 上构建发布（`.github/workflows/desktop-release.yml`），同样禁止本地出包后手动上传；推送 `main` 不会发布桌面端。见 `apps/desktop/README.md`。

涉及两个目标的修改须分别核验结果。地图与后台的自动发布不涉及数据库迁移；Spontra Analysis 自动发布先应用（`analysis:migrate:ci`）并核对分析数据库迁移，再发布 Worker。
