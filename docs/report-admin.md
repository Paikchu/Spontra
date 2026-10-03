# 财报管理后台

入口：`https://spontra-admin.max-zhangyuchen.workers.dev/admin/reports`，也可从主站设置页进入。主站旧 `/admin/reports` 跳转到独立后台，旧 `/api/admin/*` 返回 410 并清除旧会话；需要在新域名重新登录。

报告列表、版本、生成任务、检查标记均来自 `EARNING_REPORT_PIPELINE` 的分析数据库。Admin Worker 不直接读取分析 D1，也不会把只读接口改为触发生成的接口。看板不会使用示例数据兜底；数据服务异常时显示错误。

## 登录

`REPORT_ADMIN_PASSWORD` 必须在 `spontra-analysis` 配置为 Secret，建议随机生成至少 32 个字符。后台不再接受内部 `SEC_REFRESH_KEY`，没有专用密码时拒绝登录，不回退到内部密钥。`spontra-admin` 不保存这个密码；HTTP 登录凭证使用 `x-report-admin-password`。内部财报鉴权及定时任务保持独立。

使用 **财报 Pipeline Worker** 专用的 `REPORT_ADMIN_PASSWORD` 登录。不要使用投资账本 Worker 或旧 sec-cron 的同名密钥。密钥在登录时经同源 Admin Worker 代理交给 Pipeline 核验，浏览器只获得 8 小时有效的签名会话 Cookie（HttpOnly、SameSite=Strict，线上启用 Secure）。密钥不写入 localStorage、sessionStorage 或前端构建。

会话由 Pipeline 自己的密钥签名并验证，无需给 Admin Worker 新增管理密钥。轮换 `REPORT_ADMIN_PASSWORD` 会同时使现有会话失效。Pipeline 的 `REPORT_ADMIN_RATE_LIMIT` 限制登录尝试。

## 报告管理

- 搜索公司名称或代码，按待检查、已检查、生成中、生成失败和待生成筛选；列表每页 40 条，可继续加载。
- 正文复用线上报告阅读组件，包含分析、图表、研究依据、原文链接及数据质量说明。
- 已检查状态绑定财报及具体版本。新版本不会继承旧版本的检查状态；历史版本可以单独查看和检查。
- 生成记录展示任务阶段、尝试次数、时间和安全的错误代码，不转发模型提供商错误正文或凭证。
- 手动重新生成要求该公司仍在 Pipeline 的 AI 范围内，且选择具体 accession；不会自动重新生成该公司的所有报告。
- 重新生成读取已保存的财报，即使旧财报已离开最新 SEC discovery 窗口仍可执行。已核验研究材料可被复用，但报告重写、审校与发布仍运行。
- 使用操作标识、数据库短锁和已持久化的运行中任务抑制重复提交。失败任务保留记录；原报告不会被删除。
- 结构化财报沿用 `sec_published_reports` 的版本存储。简析历史存入 `sec_cache`；部署前已丢失的简析版本无法恢复。

## 接口与发布

Admin Worker：`/api/admin/session`（POST 登录、DELETE 退出）、`/api/admin/reports`（GET）、`/api/admin/reports/:ticker/:accession`（GET）、末尾 `/review` 和 `/regenerate`（POST）。写操作要求同源 Origin；全部响应为 `private, no-store`。

Pipeline 对应路径为 `/admin/*`，管理接口需要签名会话。现有公开只读凭证不能访问管理接口。所有查询和状态记录使用已有表，不新增数据库迁移。

后台代码位于 `apps/admin/`，部署为 `spontra-admin`，仅绑定 `ASSETS` 和 `EARNING_REPORT_PIPELINE`（`spontra-analysis`）。继续使用 HTTP Service Binding，生产配置缺少绑定时返回 503，不回退到公网 fetch。页面、样式和报告阅读组件保持原有设计，返回主站链接指向 `spontra-app`。

推送 `origin/main` 后，主应用自动构建会先验证、构建后台，并在 CI 中发布独立 admin Worker；没有新增第三个 Git 构建项目。后台可独立运行，但当前发布仍由主应用 CI 编排。若未来要求只改后台就独立发布，再配置单独的 Workers Builds 项目和 watch paths。首次发布无需复制数据库、迁移表或新增密钥。Pipeline 管理接口仍要求签名会话。

本次保留原有密钥登录，尚未启用 Cloudflare Access；之后可以在整个 admin Worker 上配置 Access，保持主站公开。仅推送成功不能证明线上部署成功。

## 本地验证

`npm run admin:typecheck`、`npm run admin:test`、`npm run admin:build`、`npm run admin:check`、`npm run typecheck`、`npm run typecheck:pipeline`、`npm run check:pipeline:boundary`、`npm run test:pipeline`、`npm run test:unit`、`npm run build`、`npm run worker:pipeline:check`。

`tests/admin-worker.test.ts` 验证独立 Worker 路由、HTTP Binding、Cookie、同源限制、缺失绑定和旧接口停用。`tests/pipeline/report-admin.test.ts` 使用真实 SQLite 和项目迁移验证鉴权、版本检查、精确生成、并发去重和代理 Cookie。浏览器验证记录位于根目录 `design-qa.md`；本地数据不等于生产数据验证。

## 本次验证记录

- 214 项主应用单元测试、436 项 Pipeline 测试全部通过，管理后台浏览器主流程通过。
- 主应用与 Pipeline 类型检查、边界检查、定向 ESLint、生产构建和 Pipeline dry-run 打包通过。
- 既有 rendered-html 套件为 39/42 通过。3 个旧断言（旧产品描述、旧账本比例、旧期权移动端缩进）在未修改的 `4926be7` 基线源码中复现同样失败；本次没有修改这些页面或其样式。
- 当前环境对生产域名返回网络策略 403，未进行线上密钥登录或实际生成任务测试。
- 本地开发所附 workerd 旧于项目 compatibility date；验证通过环境提供的 `/workspace/.cloud-tools/node_modules/.bin/workerd` 运行，无需更改项目生产兼容日期。
- 启动 `npm run admin:dev` 后，可用 `node --experimental-strip-types tests/report-admin.browser.mts` 重跑隔离数据库的浏览器流程。
