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

Pipeline 对应路径为 `/admin/*`，管理接口需要签名会话。现有公开只读凭证不能访问管理接口。报告管理本身使用已有表；财报数据维护任务使用下述新增迁移。

后台代码位于 `apps/admin/`，部署为 `spontra-admin`，仅绑定 `ASSETS` 和 `EARNING_REPORT_PIPELINE`（`spontra-analysis`）。继续使用 HTTP Service Binding，生产配置缺少绑定时返回 503，不回退到公网 fetch。页面、样式和报告阅读组件保持原有设计，返回主站链接指向 `spontra-app`。

推送 `origin/main` 后，主应用自动构建会先验证、构建后台，并在 CI 中发布独立 admin Worker；没有新增第三个 Git 构建项目。后台可独立运行，但当前发布仍由主应用 CI 编排。若未来要求只改后台就独立发布，再配置单独的 Workers Builds 项目和 watch paths。首次发布无需复制数据库、迁移表或新增密钥。Pipeline 管理接口仍要求签名会话。

本次保留原有密钥登录，尚未启用 Cloudflare Access；之后可以在整个 admin Worker 上配置 Access，保持主站公开。仅推送成功不能证明线上部署成功。

## 财报数据维护

后台导航的「财报数据」打开 `/admin/financials`，复用上述登录，不接受内部维护密钥作为浏览器会话。页面 URL 中仅保留选中的股票代码；刷新后会重新读取服务端任务。

- 页面以完整财报阅读为主：左侧选择公司，上方选择财报期间，按资产负债表、利润表、现金流量表、其他报表和附注切换实际存在的表格。
- 常见财务项目提供中文名称，保留原始名称可供查看；表格保留披露金额、比较期间、空白、破折号和合并表头。表内搜索高亮并定位结果，不筛掉小计或打乱原始行序。展开阅读可获得更宽的表格空间。
- 页面不再展示逐单元格出处、原始标签档案、提取统计和覆盖清单。原始文档与事实仍保存在后台，表格的单位及说明保留在「报表说明」。
- 「查看季度摘要」默认折叠，可选择两个季度、筛选利润费用或业务收入、搜索项目和切换金额单位。摘要只呈现已有指标；缺失显示为破折号，真实的零保留，不生成未经核验的增长率。
- 公司列表不按获取方式分类。最新数据期间与更新时间取已成功保存的数据；后续失败或排队中的更新不覆盖它们。
- 「更新数据」获取最新财报并补充已有数据，完成后自动刷新；「更新记录」按需打开，显示进度、结果及重试或停止操作，关闭页面不会停止后台更新。生成财报分析仍要求现有 AI 开关和 Workflow 可用。
- 添加公司后可获取财报数据；获取方式不影响已有数据的展示，定时任务范围与全局开关仍由后台配置控制。
- 提交、重试、取消均要求同源请求与有效管理会话。浏览器只在 sessionStorage 保留待确认操作的 UUID；网络中断后重试复用它，不保存密码或财报正文。服务端仍抑制同公司并发重跑。

新增代理资源：`/api/admin/financials/companies`、`/companies/:ticker`、`/companies/:ticker/documents/:documentId`、`/companies/:ticker/actions`、`/tasks/:taskId` 和 `/tasks/:taskId/cancel`。公司、文档、任务查询只读，操作与取消使用 POST。代理白名单与原有签名会话限制保持独立。

发布前需应用 Pipeline 迁移 `0014_financial_maintenance.sql`，并同时发布 Pipeline 与独立 admin 构建。任务在写入前保留可恢复的数据备份；实际修复与备份范围见当次任务记录。仅前端页面构建成功不代表后台迁移或生产任务已验证。

## 本地验证

`npm run admin:typecheck`、`npm run admin:test`、`npm run admin:build`、`npm run admin:check`、`npm run typecheck`、`npm run typecheck:pipeline`、`npm run check:pipeline:boundary`、`npm run test:pipeline`、`npm run test:unit`、`npm run build`、`npm run worker:pipeline:check`。

`tests/admin-worker.test.ts` 验证独立 Worker 路由、HTTP Binding、Cookie、同源限制、缺失绑定和旧接口停用。`tests/pipeline/report-admin.test.ts` 使用真实 SQLite 和项目迁移验证鉴权、版本检查、精确生成、并发去重和代理 Cookie。浏览器验证记录位于根目录 `design-qa.md`；本地数据不等于生产数据验证。

## 首次拆分后台时的验证记录（历史）

- 214 项主应用单元测试、436 项 Pipeline 测试全部通过，管理后台浏览器主流程通过。
- 主应用与 Pipeline 类型检查、边界检查、定向 ESLint、生产构建和 Pipeline dry-run 打包通过。
- 既有 rendered-html 套件为 39/42 通过。3 个旧断言（旧产品描述、旧账本比例、旧期权移动端缩进）在未修改的 `4926be7` 基线源码中复现同样失败；本次没有修改这些页面或其样式。
- 当前环境对生产域名返回网络策略 403，未进行线上密钥登录或实际生成任务测试。
- 本地开发所附 workerd 旧于项目 compatibility date；验证通过环境提供的 `/workspace/.cloud-tools/node_modules/.bin/workerd` 运行，无需更改项目生产兼容日期。
- 启动 `npm run admin:dev` 后，可用 `node --experimental-strip-types tests/report-admin.browser.mts` 重跑隔离数据库的浏览器流程。

## 业务地图公司管理

导航「业务地图」进入 `/admin/business-map`。输入股票代码并加入白名单后，Pipeline 在同一个 D1 事务中保存公司配置和首次数据准备任务。配置存于 `financial_company_settings`，覆盖 `SEC_DATA_TICKERS` 的部署默认值；显式移出也不会被后续部署重新加入。操作回执独立保存，网络重试不重复建任务，旧请求重放不会覆盖后来的移出操作。此配置不扩展 AI 分析白名单。

- 管理页自动刷新公司识别、最新财报采集、历史扫描、披露检查的进度，显示文件扫描数量、最近更新时间、具体问题以及重新准备入口。
- 收入构成逐季区分「分部及抵销已核验」「财报明确单一报告部门」「仅合并收入、拆分待核验」。最后一种显示警示，并将维护结果保留为部分完成，不能被合并收入占位标记为地图完整。
- 「地图已就绪」要求与公开地图一致的完整性校验；后台任务结束并不代表所有历史资料都完整。部分历史披露无法提取、重述待核验或原始事实格式暂未支持时，问题仍保留。
- 全局自动采集暂停时，新公司仍执行管理员明确提交的首次准备；后续定时更新等待全局开关恢复。
- 移出白名单停止后续自动采集，保留已有公开数据和已明确提交的维护任务。需要停止本次任务，可从「查看财报与更新记录」操作。
- 数据消费者、刷新生产者和后台读取使用同一持久化公司范围。取消或失败的维护任务会释放其子采集任务，维护开始前也会等待已运行的同发行人自动采集。
- 采集支持 20-F / 6-K，并按 Exhibit 99 表格链接发现附件，不依赖附件文件名。未标记 XBRL 的合并利润表按明确的期间列与美元单位解析；同一份报表内的六个月累计减第二季度可推导第一季度，保留两项来源和公式。无法核验的数字不进入地图。
- 同一报表的分部收入表按日期列提取，分部合计、内部交易抵销、合并收入逐层勾稽。抵销单独保存、展示，不按业务比例分摊；业务占比使用抵销前分部合计为分母。历史业务收入保留原分部金额，全部业务趋势保留抵销后的合并口径。

私有接口：`GET /api/admin/business-map/companies`、`POST /api/admin/business-map/companies/:ticker`（`enabled`、UUID `requestId`）。继承签名会话、同源写入限制与服务绑定；状态列表合并读取，查询次数不随公司数增长。

新增迁移：`0016_business_map_companies.sql`。当前 `worker:pipeline:deploy` 的 CI 入口先执行 `worker:pipeline:migrate:ci` 再核对迁移，随后发布；必须同时发布 Pipeline、Admin 与业务地图（共享完整性校验更新），依旧只通过推送 `origin/main` 触发自动部署。

## AI 生成（财报发现、业务解读、业绩指引）

导航「AI 生成」进入 `/admin/ai`，URL 保留 `?ticker=&kind=`。公司范围为 Pipeline 的 AI 分析白名单（`SEC_AI_TICKERS`）。

- **手动触发**：按公司、按类型提交一次运行，不要求修改 `FINDINGS_VERSION` 等版本号，也不要求财报、指引或综述变化。发现与业务解读以当前数据指纹启动，发布后定时任务视其为最新，不会重复生成。业绩指引需选择一份业绩发布 8-K（默认最新），手动运行会对其材料重新调用模型提取，只读取一次电话会文字稿、不进入多日等待；仍计入每日模型额度。
- 手动触发不受 `FINDINGS_ENABLED`、`GUIDANCE_ENABLED` 等自动开关限制，但需要对应 Workflow 绑定和模型密钥；业务解读还需要 `TAVILY_API_KEY`。同一公司同一类型（指引为同一份 8-K）有进行中的运行时拒绝重复提交；请求标识保证网络重试不重复启动。
- **进度**：每次运行（含定时任务启动的）记录触发方式、状态、当前步骤和逐步时间线，步骤在 Workflow 的持久化步骤内写入，重放不会回退。运行结束时记录结果摘要；发现会列出未通过核对的条目及原因。运行异常终止而未写入结果时，查看详情会向 Workflow 引擎核对并标记失败。
- **结果与历史版本**：每次发布在 `sec_cache` 中另存一份版本（`ai-version:v1:<kind>:<ticker>:<时间>`），内容与上一版相同则不重复保存，每类每家公司保留最近 30 版；运行记录（`ai-run:v1:…`）保留最近 20 次。页面默认显示当前线上版本，可切换查看历史版本并展开原始 JSON。历史从本功能上线后开始积累，此前只保留当前版本。
- 无新增迁移。接口：`GET /api/admin/ai/companies`、`GET /api/admin/ai/companies/:ticker/:kind`、`GET …/:kind/versions/:id`、`POST …/:kind/runs`（`kind` 为 `findings`、`explainer`、`guidance`）。
