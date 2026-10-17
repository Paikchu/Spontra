# BusinessView 后台

入口：`https://spontra-admin.max-zhangyuchen.workers.dev/admin/whitelist`。后台只服务 BusinessView（业务地图），所有数据来自 `EARNING_REPORT_PIPELINE` 的分析数据库；Admin Worker 不直接读取分析 D1，数据服务异常时显示错误，不用示例数据兜底。

## 视觉

后台沿用 Spontra Design System（Ink & Highlighter），与 BusinessView 同一套 token（`packages/web/src/styles/globals.css`）：默认墨色主题，侧栏底部可切到纸色，选择保存在本浏览器。样式只引用语义 token，不写死颜色；每屏只有一个荧光笔主按钮，其余为描边药丸按钮；标签页为药丸分段控件，选中项反色；代码、accession 等标识用等宽字体。页面不设大标题，位置由侧栏高亮表示；公司列表只显示 logo、代码和数量，不显示公司全名。

## 导航

| 页面 | 路径 | 内容 |
|---|---|---|
| 白名单管理 | `/admin/whitelist` | 公司列表：状态、可展示期间、收入构成、采集进度、问题数与操作，展开一行查看各期收入构成、任务进度和采集问题；可进入「财报与更新记录」（`/admin/financials`，导航仍高亮白名单管理） |
| SEC 文件拆分 | `/admin/filings` | 三栏：公司（logo、代码、文件数、问题数）｜所选公司的申报（按年份）｜内容区（申报的正文、新闻稿、附件分标签，章节、原文段落、索引卡、重新拆解；未选申报时显示全库统计）。内容区另有「跨公司查找」。地址带 `?ticker=&accession=&document=&section=`，浏览器后退回到上一步 |
| 公司业务板块 | `/admin/business` | 板块数据（文件库拼出的公司页面：分部数字与原文）、图表数据（BusinessView 利润、现金流、资产负债三张图背后的逐季数字，百万为单位；接口 `GET /api/admin/business-map/companies/:ticker/charts`，与地图读同一份发布数据与快照，只读）、业务脑图、业务解读、业务主线（提议与独立复核自动核验，无需人工确认） |
| 公司要点 | `/admin/findings` | 要点的当前版本、历史版本、运行记录与手动重新生成 |

旧路径 `/admin/business-map`、`/admin/library`、`/admin/ai`（`kind=findings` 进入公司要点，其余进入公司业务板块）打开对应的新页面并改写地址；其他路径进入白名单管理。业务板块、要点页面的 URL 保留 `?ticker=`，从业务板块打开的原文小节以 `/admin/filings?ticker=&document=&section=` 定位。

报告管理、生成任务、Transcript、业绩指引不属于 BusinessView，事件流水线（运行状态）由 Cloudflare 控制台替代，后台已移除这些页面，Admin 代理也不再转发 `reports`、`transcripts`、`guidance` 与 `pipeline` 接口；Pipeline 自身的这些接口和数据未改动。

运行状况在 Cloudflare 控制台查看：Cron 在 `spontra-analysis` 的 Settings → Trigger Events；队列积压与重试在 Queues 的三条 `spontra-pipeline-*` 队列；Workflow 实例在 Workflows；报错与重试在 `spontra-analysis` 的 Workers Logs（按 `pipeline-task`、`pipeline-route`、`pipeline-dead` 筛选）。死信仍写入 D1 `pipeline_dead`，后台不再提供重放、关闭和手动发送事件的入口。

## 登录

`REPORT_ADMIN_PASSWORD` 必须在 `spontra-analysis` 配置为 Secret，建议随机生成至少 32 个字符。后台不再接受内部 `SEC_REFRESH_KEY`，没有专用密码时拒绝登录，不回退到内部密钥。`spontra-admin` 不保存这个密码；HTTP 登录凭证使用 `x-report-admin-password`。内部财报鉴权及定时任务保持独立。

使用 **财报 Pipeline Worker** 专用的 `REPORT_ADMIN_PASSWORD` 登录。密钥在登录时经同源 Admin Worker 代理交给 Pipeline 核验，浏览器只获得 8 小时有效的签名会话 Cookie（HttpOnly、SameSite=Strict，线上启用 Secure）。密钥不写入 localStorage、sessionStorage 或前端构建。

会话由 Pipeline 自己的密钥签名并验证，无需给 Admin Worker 新增管理密钥。轮换 `REPORT_ADMIN_PASSWORD` 会同时使现有会话失效。Pipeline 的 `REPORT_ADMIN_RATE_LIMIT` 限制登录尝试。

## 接口与发布

Admin Worker：`/api/admin/session`（POST 登录、DELETE 退出），其余为 `financials`、`business-map`、`ai`、`library` 的白名单路径。写操作要求同源 Origin；全部响应为 `private, no-store`。

Pipeline 对应路径为 `/admin/*`，管理接口需要签名会话。现有公开只读凭证不能访问管理接口。报告管理本身使用已有表；财报数据维护任务使用下述新增迁移。

后台代码位于 `apps/admin/`，部署为 `spontra-admin`，仅绑定 `ASSETS` 和 `EARNING_REPORT_PIPELINE`（`spontra-analysis`）。继续使用 HTTP Service Binding，生产配置缺少绑定时返回 503，不回退到公网 fetch。页面、样式和报告阅读组件保持原有设计，返回主站链接指向 `spontra-app`。

推送 `origin/main` 后，地图与后台的自动构建会先验证、构建后台，并在 CI 中发布独立 admin Worker。若未来要求只改后台就独立发布，再配置单独的 Workers Builds 项目和 watch paths。首次发布无需复制数据库、迁移表或新增密钥。Pipeline 管理接口仍要求签名会话。

本次保留原有密钥登录，尚未启用 Cloudflare Access；之后可以在整个 admin Worker 上配置 Access，保持主站公开。仅推送成功不能证明线上部署成功。

## 财报数据维护

白名单管理卡片上的「查看财报与更新记录」打开 `/admin/financials`，复用上述登录，不接受内部维护密钥作为浏览器会话。页面 URL 中仅保留选中的股票代码；刷新后会重新读取服务端任务。

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

`npm run admin:typecheck`、`npm run admin:build`、`npm run admin:check`、`npm run typecheck`、`npm run typecheck:pipeline`、`npm run check:pipeline:boundary`、`npm run build`、`npm run worker:pipeline:check`。

## 业务地图公司管理

导航「白名单管理」进入 `/admin/whitelist`。输入股票代码并加入白名单后，Pipeline 在同一个 D1 事务中保存公司配置和首次数据准备任务。配置存于 `financial_company_settings`，覆盖 `SEC_DATA_TICKERS` 的部署默认值（部署默认值新增的公司由申报发现 Cron 在下一次运行时解析 CIK 并请求首次采集；第二股份类别如 GOOG 统一折算为 GOOGL）；显式移出也不会被后续部署重新加入。操作回执独立保存，网络重试不重复建任务，旧请求重放不会覆盖后来的移出操作。此配置不扩展 AI 分析白名单。

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

## 模型生成（公司要点、业务脑图、业务解读）

「公司要点」显示要点；「公司业务板块」的「业务脑图」「业务解读」显示另外两类。公司要点与业务解读的范围是 `SEC_AI_TICKERS`，业务脑图是 `BUSINESS_TREE_TICKERS`；不在范围内的公司显示「该公司不在 AI 分析范围内」。

- **手动触发**：按公司、按类型提交一次运行，不要求修改 `FINDINGS_VERSION` 等版本号，也不要求财报、指引或综述变化。以当前数据指纹启动，发布后事件任务视其为最新，不会重复生成。
- 手动触发不受 `FINDINGS_ENABLED` 等自动开关限制，但需要对应 Workflow 绑定和模型密钥；业务解读还需要 `TAVILY_API_KEY`。同一公司同一类型有进行中的运行时拒绝重复提交；请求标识保证网络重试不重复启动。
- **进度**：每次运行（含定时任务启动的）记录触发方式、状态、当前步骤和逐步时间线，步骤在 Workflow 的持久化步骤内写入，重放不会回退。运行结束时记录结果摘要；要点会列出未通过核对的条目及原因。运行异常终止而未写入结果时，查看详情会向 Workflow 引擎核对并标记失败。
- **结果与历史版本**：每次发布在 `sec_cache` 中另存一份版本（`ai-version:v1:<kind>:<ticker>:<时间>`），内容与上一版相同则不重复保存，每类每家公司保留最近 30 版；运行记录（`ai-run:v1:…`）保留最近 20 次。页面默认显示当前线上版本，可切换查看历史版本并展开原始 JSON。历史从本功能上线后开始积累，此前只保留当前版本。
- 无新增迁移。接口：`GET /api/admin/ai/companies`、`GET /api/admin/ai/companies/:ticker/:kind`、`GET …/:kind/versions/:id`、`POST …/:kind/runs`（`kind` 为 `findings`、`explainer`、`tree`）。

## 税前至净利润（2026-10-15）

白名单详情的"税前至净利润"区显示最新季度这一段算术的来源：申报计算链、报表行、模型判定（算术核验）或未拆分（合计）；列出所得税之后的各行（权益法损益、少数股东损益等）、被后续申报重述而不比较环比的行，以及模型判定记录（状态、次数、判定的申报、未通过的原因）。"重新判定"只是再发一次 `presentation.unresolved`，流程不等它。见 [statement-bridge-design](statement-bridge-design.md)。

## AI 分析开关（2026-10-15）

白名单表新增"AI 分析"一列，逐家开启或关闭 AI 分析（SEC 报告、业绩指引、公司分析、要点、要点分析师、业务解读及其翻译）。选择存于 `financial_ai_settings`（migration 0026），覆盖部署默认值 `SEC_AI_TICKERS`，显式关闭同样生效，与白名单覆盖 `SEC_DATA_TICKERS` 的方式一致。Pipeline 在每个入口（请求、Cron、队列、Workflow）读一次这两张表，下游代码照旧读环境变量。只有已在白名单中的公司可以开启。开启时发出 `ai.enabled`，由 `sec-report` 与 `explainer` 接手，其后的指引、公司分析、要点与分析师按原有事件链跟上；关闭后不再有新的运行，已发布的内容由存储清理按原规则处理。首页的要点轮播改为读取已发布要点的公司列表（`/api/business/v1/findings`），不再写死在页面里。
