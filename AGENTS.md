# 工作原则

从第一性原理出发解决问题，直击根源，主动完善需求。验证应聚焦本次要验证的问题。

# Git 与上线规则

- 本仓库唯一远程为 `origin`，fetch 和 push 均指向 `https://github.com/Paikchu/spontra.git`。所有分支与 worktree 共用此远程，不添加其他发布远程。
- 唯一生产发布入口是 GitHub 的 `main` 分支。用户要求“上线”或“部署”时，将已验证的本次修改提交并合并到本地 `main`，执行 `git push origin main`，由 Cloudflare 自动部署。
- 禁止本地手动部署，包括 `wrangler deploy`、`wrangler versions upload/deploy`、`wrangler pages deploy`、直接调用部署 API，以及本地运行 `deploy:cloudflare`、`sec-cron:deploy`、`worker:pipeline:deploy` 等发布脚本。这些部署脚本仅供自动构建执行。自动部署失败时，修复后再次推送，不绕过自动部署。
- 用户只要求提交或合并时，不自动推送。用户要求上线时，推送已获授权，不重复请求确认。

## 发布步骤

1. 检查 `git status --short`、当前分支及 `git remote -v`，确认 `origin` 的 fetch/push 地址正确；执行 `git fetch origin --prune` 核对远程变化。
2. 只暂存本次任务修改，保留其他任务的未提交内容；同文件混有其他修改时按 hunk 暂存。不使用强制推送，不丢弃已有工作。
3. 执行与修改相关的测试、类型检查及必要构建，检查 `git diff --cached --check`，提交并安全合并到本地 `main`。
4. 执行 `git push origin main`。核对 `git rev-parse main` 与 `git ls-remote origin refs/heads/main` 的 SHA 一致。
5. 核验该提交对应的 Cloudflare 自动构建与线上功能。若无法获取构建状态，明确报告“已推送，自动部署结果未核验”，不能把推送成功当作上线成功。

## 自动部署目标

推送 `origin/main` 触发两个独立构建，根目录均为 `/`：

- 主应用及 `sec-cron`：构建 `npm run build`，CI 执行 `npm run deploy:cloudflare`。
- 财报 Pipeline：构建 `npm run check:pipeline:boundary && npm run typecheck:pipeline && npm run worker:pipeline:check`，CI 执行 `npm run worker:pipeline:deploy`。

涉及两个目标的修改须分别核验结果。主应用自动发布包含投资账本迁移；Pipeline 自动发布只核对分析数据库迁移，不自动应用迁移。若修改依赖新迁移，应完善自动发布流程后再上线。
