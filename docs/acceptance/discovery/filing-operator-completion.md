# 财报外部作者完成路径：本地真实链路验收

本验收只验证完成路径、持久化与发布门槛。数据、旧失败检查点和所有模型响应均为合成内容；浏览器、报告组件、业务工具和服务执行链是真实实现。没有生产读写、真实模型调用、真实用户签核或部署。遵循根目录 `AGENTS.md`，以实际用户操作旅程验证，没有新增单元测试。

执行脚本：[filing-operator-completion-acceptance.mjs](../../../scripts/filing-operator-completion-acceptance.mjs)。机器可读结果：[filing-operator-completion.json](results/filing-operator-completion.json)。结果中的 `at`、`checks`、`transports` 与 `screenshots` 为本轮实际证据。

2026-11-17 04:33 UTC 完整历史基线运行正常退出（exit 0）：171 项全部通过，107 次合成 provider HTTP，66 张真实 Chromium 截图，真实模型调用和生产访问均为 0。包含原完成路径的 99 项检查及复核意见修正旅程，原结果 JSON 逐字节保留；其中旧的同步坏证明拒绝行为已由下述异步验收替代，不代表本轮重新执行全部 171 项。原成功路径为 8 次独立复核和 18 张截图；修正成功路径新增 3 次复核和 18 张截图，其余用于负向与并发旅程。

## 实际执行链

`POST /api/admin/reports/TICKER/ACCESSION/shadow/SOURCEID/operator-complete` 经真实管理端代理、命名 `AdminGateway` 和真实管理处理器，创建命名 `FILING_OPERATOR_COMPLETION_WORKFLOW:RUNID` 的 `TaskRunner`。任务不新建 Pi 作者会话。

隔离 Miniflare 提供真实 D1、R2 与 Durable Object SQLite。脚本只种入合成旧会话和旧公开版本，随后由真实处理链读取精确失败 leaf、认领单一 lineage、执行正常 `runTool`，再执行 `prepare → 每块 content → semantic → render → shadow`。不由客户端传入 state 或成功回执，不直接种入 composer 验收成功结果。

真实工具完成固定财报读取、事实查询、追加 `c2/c3`、`E7` 原笔记哈希及原文引文修正、线索处置、冻结宏观适用性记录、投资传导链、显式日期图表与原六块 HTML 写入。旧 `c1` 留在历史计算中，但不能继续由正文、图表、传导链或其依赖引用。

`qa.ts` 使用 Cloudflare Puppeteer 的正常 BrowserWorker 协议；本地 HTTP/WebSocket 转接只负责连接真实 Chromium CDP。页面实际加载生产源码的 `ArtifactFrame.tsx`、`artifact-frame/main.ts`、主题和组件行为。外围固定侧栏是精简本地壳，未模拟整个生产公司页面。三个规定视口分别测量、截图所有六块：`1440x900 light`、`390x844 light`、`1280x800 dark`。成功路径有 18 张实际截图送达模型 HTTP 传输；不是伪造的几何或截图回执。全部截图的路径、字节数及 SHA-256 记录在结果 JSON，图片留在本轮 `/tmp` 目录。

## 不变量与故障处理

- 只允许精确、自然结束且额度用尽的未验证 periodic leaf；已有续作的父任务不能绕过子任务，operator 不能递归 resume。认领绑定固定检查点、公开版本及哈希、作者、规范化 plan 哈希，一个 lineage 只有一个计划。
- 外部作者元数据为 `gpt-6.1-sol / max`。这是完成计划的来源记录，不代表服务又调用了作者模型；无法取得作者 token 和费用，保持 `unavailable / null`。独立复核的模型与请求数另列，不能把外部作品冒充原续作模型完成。
- 原作者 140 次与续作 40 次账本、原失败回执及原检查点不变。独立复核固定 12 次，包含内容、语义、视觉以及 SDK 自动重试的每次 HTTP 发送。成功路径为六次内容、一次语义、一次视觉，共 8/12。
- 每个阶段先持久化 `started`、输入 state 引用和 10 分钟 lease，再进行外部工作；完成后写入 state 哈希和回执。RunStep 为 11 分钟且 `retries.limit=0`，低于引擎 13 分钟上限。已开始而未完成的工作在恢复时转为 `unknown`，不自动再次计费。
- 任务停止、lease 失效、冷重启或公开版本/哈希变化后，迟到的 provider 成功也不能写入完成回执或暴露 validated shadow。验收使用真实在途请求与真实 `ctx.abort`；超时通过令真实 lease 立即失效注入，未等待完整 11 分钟墙钟超时。
- 只有内容、完整语义和严格三视口渲染均通过才产生 validated shadow。缺少合法 `issues` 数组、无合法问题字段的内容复核响应、缺失视口、视觉服务不可用、重大内容或语义错误均失败。零视觉请求与缺口不会被当作通过。
- validated 对象为内容寻址，GET/promote 绑定实际 state/spec、source checkpoint、plan/author 与版本/哈希。篡改保存对象不能取得 artifact 或 preview。完成不等于人工审核；作者不能自审，只有明确的独立审核和精确哈希、全部 chain 才可 promote。

## 已覆盖的操作

1. 未授权、跨来源、错误方法/UUID、非法 schema、客户端 state/回执、模型覆盖、重复必需块、错误来源/检查点/公开哈希均拒绝；有效请求通过真实代理派发一次。
2. 精确重复与同时提交同一请求返回同一 durable claim；不同计划或第二 UUID 冲突。无新的作者会话。GET 返回实际独立复核 8/12、Sol 外部作者和来源链。
3. 内容错误、完整语义错误、缺失移动视口、视觉 provider 不可用、畸形内容响应和畸形问题条目不能验证。真实 `revise_evidence` 拒绝不存在于固定原文的引文；退休计算仍可达也拒绝。
4. 在真实 content 阶段，通过实际 `judge` SDK 和生产 `reserveFilingOperatorReview` 消耗额度；失败 HTTP 与自动重试合计到 12，八个并发客户端争抢最后一个名额只发送一次 HTTP，超额和恢复均不再发送。
5. 实际在途响应跨 lease 过期、冷重启、显式停止、同版本下公开哈希改变均受完成围栏约束。全套失败后，旧公开版本与原 140/40 账本仍保持。
6. 最后仅在隔离数据库内由 `synthetic-independent-human-local-only` 明确审核并调用正常 promote。真实公开财报及 artifact 读函数返回同一完整版本；摘要为 `source=external`、`generatedBy=operator`，带精确 plan、checkpoint、Sol 作者信息。该模拟审核不是用户对 CRWV 的签核。

## 采纳服务器复核意见：原 7 次 + 新 3 次

窄入口为 `POST /api/admin/reports/TICKER/ACCESSION/shadow/OPERATORID/apply-reviewer-corrections`。必须有 UUID 幂等键，正文上限 8 KiB，只接受 `expectedPlanHash`、`expectedFailedStateHash`、`expectedSemanticReceiptHash`、`expectedPublicVersion` 和 `expectedPublicHash`。其中语义回执哈希为 `sha256(JSON.stringify(source.stages.semantic.receipt))`，保留原属性顺序；它不是原始模型回执文件的哈希，也不使用规范化排序。

本轮先用真实阶段产生六次通过的内容复核与一次失败的完整语义复核。该语义复核仅对 summary 中一句纯文本给出精确 quote 和 plain-text replacement。服务器实际执行 `apply_fixes`，结果必须恰为该处唯一替换；不接客户端 HTML、新计划、引文、状态、作者或额度，不重新进行研究、计算或启动作者模型。原失败 ledger、plan、state 和 failure 对象逐字节保留。

HTTP 入场只校验轻量身份、原失败回执元数据、原始 ledger/public CAS 并认领一次，返回 202。大状态读取、状态内语义回执匹配、冻结研究校验、原生修正和五块完整证据重建由同一 TaskRunner 的非付费 `corrections/prepare` 阶段执行，全部早于第一笔新增模型请求。确定性不匹配保存为 `failed`，新请求数为 0；技术中断或 lease/fence 失败仍保留 `unknown`。没有调高管理代理 30 秒超时，也没有删除校验。

其余五块通过 `reconstructedLegacy-v1` 重建原始完整模型请求。验收逐块核对 `reusedFrom` 的来源 run/phase、真实 before/after state 引用、原成功回执哈希、完整 `inputHash`、`blockHash`，并以 SQL 查到同一时点、阶段、模型、推理配置且 `outcome=ok` 的实际 `ai_usage` 行。新请求中的 HTML、标题、来源文本、已通过句子或建立的事实发生变化时，不允许凭旧 passed 标志复用。

成功路径实际只发送三次新增 HTTP：summary 内容复核、包含全部六块与完整材料的语义复核、所有三视口的严格视觉复核。其余五块没有新增内容模型请求，新的 validated shadow 保存了原计划与 reviewer-correction 来源信息。GET 明确返回 `reviewCalls=3`、`reviewCallsInherited=7`、`callsReserved=10`、`maxCalls=12`；原失败任务仍是 7 次，未被改成成功。

新增负向旅程已实际执行：

- 身份哈希或公开版本错误、额外 HTML/plan/quote 等八类字段、过大正文、非语义失败、没有精确 quote 的语义失败均拒绝。
- 篡改原成功用量行的模型、改变未修正块 HTML、改变来源证据文本，HTTP 先返回 202 单次认领，再由 durable 非付费阶段保存 `failed / reviewCalls=0 / reviewCallsInherited=7`；不会暴露 preview 或进入新增模型调用。故障注入后恢复原记录。
- 同时提交相同请求只形成一个认领和一个确定性任务；精确重放零新增请求，不同 UUID、改变身份或对修正版本再修正均拒绝。
- 修正任务继承原 7 次，只能再占 5 次。用真实 `judge` SDK 消耗剩余额度后，合计 12 次即阻断下一语义 HTTP，不允许重置为新的 12 次。
- 修正任务在实际 changed-block HTTP 在途时冷重启、lease 失效或显式停止，迟到成功不能验证，也不会自动重发。作者自审与自动公开均被阻止。

结果 JSON 的 `reviewerCorrection` 单独记录原 7、新 3、累计 10 及五块复用证据。修正版本保持待人工审核影子状态；文中最后的独立模拟 promote 是对原完成路径的隔离验收，不代表用户批准这份修正版或任何真实报告。

## 异步认领与慢 R2 的独立验收

最新窄旅程结果单独保存在 [filing-reviewer-correction-async-admission.json](results/filing-reviewer-correction-async-admission.json)，不覆盖历史 171 项基线。它只重验本次变化的异步坏证明、慢 R2、继承额度和中断边界；未重复浏览器质量与全部宽旅程。

2026-11-17 05:01 UTC 最终窄旅程 exit 0：47/47 项通过，64 次全合成 provider HTTP，真实模型及生产访问均为 0。实际 R2 返回持有 31501 ms（2026-11-17T05:00:59.610Z 至 2026-11-17T05:01:31.111Z），真实代理 202 耗时 577 ms，精确重放 41 ms；代理仍为 30000 ms。终态 prepare failed、新 0、继承 7、单派发、公开 v6/原哈希均已实际断言。此前 46 项临时结果由这次包含公开指针断言的 47 项结果替代。

fixture 在 default handler、实际 `AdminGateway` 基类 fetch 与 TaskRunner 三个入口包装 R2 传输。目标 `SEC_FILINGS.get` 先实际读取并确认对象存在，再控制其返回延迟超过 30 秒，因此同步预演若仍留在 API 内会触及原代理超时；没有伪造一个直接返回 202 的处理器。请求仍经过真实同源代理、命名 AdminGateway、认领 CAS 与确定性任务。释放延迟后，坏用量证明在非付费 prepare 阶段保存 `failed / new0 / inherited7`；显式读取公开指针确认 version 6 和原哈希未变。延迟期间精确重放仍只派发一次。

```bash
SPONTRA_ASYNC_PROOF_ONLY=1 node scripts/filing-operator-completion-acceptance.mjs
```

## 运行和解释结果

```bash
node scripts/filing-operator-completion-acceptance.mjs
```

需要已安装项目依赖和本地 Chromium；默认 `/usr/bin/chromium`，可用 `CHROMIUM_PATH` 指定。脚本使用假密钥，所有模型 HTTP 由本地合成传输响应，拒绝其他 outbound 主机。正常结束写结果 JSON；任何断言失败使进程失败。已执行脚本语法检查与单文件 ESLint。

成功的本地机械验收不能证明真实财务结论或真实模型的语义/视觉判断质量。真实报告生成、生产公开页面与部署均不在这份本地证据中；完整生产 React 外围页面也没有在本脚本中验收。

## 真实 CRWV 计划的独立预检记录

根任务另有 `/tmp/spontra-crwv-sol/operator-plan-preflight.json`：真实作者计划仅通过 schema、检查点及固定公开基准预检，`productionWrite=false`、`providerHttpSends=0`。它未执行独立内容、语义或视觉验收，不能从上述合成结果推断其已通过。

规范化计划哈希为 `3b9f0f1cecc946b89eb4a7a2049aff16429ecebee5633e0f6f05c5d23c57949b`；原始文件 SHA-256 为 `30025a6660a117a3d9947fa50b8222123f0701178494e59994e6476b3253153c`。前者绑定解析后按键规范化的计划，后者绑定原始文件字节，二者不能混用。该 `/tmp` 记录独立于本地合成结果，本脚本不覆盖它。

最终计划仅将 risks 中舍入值的 “exact” 修正为 “approximately”；原文件和前次预检原样保留，26 条计算、数值与引用没有变化。[最终身份预检](results/filing-operator-plan-preflight.json) 记录新旧哈希；这只是本地身份检查，生产公开基准仍需正式入场前回读。

## 代码兼容回归

最终实现还通过 `npm run check`（全部类型检查与两站构建）、`npm run analysis:typecheck`、定向 ESLint、Workers dry-run 及 `git diff --check`。全仓 lint 仍为此前的 9 errors / 5 warnings，本次文件无新增问题。原续作真实 Miniflare 旅程 104 项、原公开证据旅程 18 项、原影响发布旅程 31 项、原单位与硬门槛旅程 26 项均通过；这些回归不调用真实模型。两份旧发布旅程只为既有 QA 边界替身补充新增的 `VIEWPORTS` export，仍明确使用合成渲染结果，不作为 operator 严格渲染证明。

## 保存的真实 CRWV 输入离线复演

[真实保存输入预检](results/filing-reviewer-correction-real-input-preflight.json) 使用原失败 `4a90d356…` 状态、全部内容阶段前后原字节状态、原七条 `ai_usage` 以及固定 Q3/Q2 完整 index/Markdown，在隔离本地环境调用生产 `previewFilingReviewerCorrections`。实际原生 `apply_fixes` 只替换 summary 的唯一审阅原句；五个未变块的完整 request/body、来源、established、模型/有效 effort 与历史输入重建相同，`reuseContent` 全部通过。研究事实、来源、计算保持原样；只清除修订副本中的旧语义回执以强制重审。耗时约 2.4 秒，网络、模型、应用数据库及对象写入均为 0。

旧 v1 回执未记录原 HTTP body 的哈希。`reconstructedLegacy-v1` 是根据当时保存的输入和未变的 v1 请求构造逻辑所做的重建，不能声称当时已存 requestHash。原部署 `9830deae` 的审阅 prompt 与输入构造已独立核对未变；原使用账本证明 `deepseek-flash/high`，当前配置为 built-in route、无 tool/endpoint 覆盖，并且本轮没有改模型配置。缺少配置行不是历史 endpoint URL 或 updated_at 的证明；历史 route 本身没有保存回执，这一边界明确保留。若保留的 endpoint/tool 配置在原调用后被修改，或来源读取/搜索失败，服务器拒绝 legacy 复用。新的内容回执直接保存实际 `inputHash`，无需把历史缺失字段冒充当时证明。

本项没有触发真实修订请求。仍需对修正后的 summary 真实审阅、全文 semantic 及全部规定视口的 provider visual review；旧失败 7 次预算和公开版本 6 均保留，由根任务按完整证据决定受控上线与执行。

## 本轮真实纠偏的入场身份与未认领尝试

原失败 run 为 `shadow-CRWV-0001769628-26-000465-operator-fa63bc5c-783b-40fc-99ed-557f8bed6012`，保留 failed 状态和已消费 7/12。管理端窄路径为 `POST /api/admin/reports/CRWV/0001769628-26-000465/shadow/原失败runId/apply-reviewer-corrections`，要求新的 UUID `idempotency-key`，正文严格只接以下五项（8 KiB）：

```json
{
  "expectedPlanHash": "3b9f0f1cecc946b89eb4a7a2049aff16429ecebee5633e0f6f05c5d23c57949b",
  "expectedFailedStateHash": "4a90d3565fda8f1c577253bab378042e856437695cd01b9c6baf4e07f5bcff01",
  "expectedSemanticReceiptHash": "d04cc6d42d69bbda14fed3a5b01a4e5f9eca3b16248a6522356bc3da44a7edc8",
  "expectedPublicVersion": 6,
  "expectedPublicHash": "74e07b8a521f5084c84b920ef82bf442ad993c945e4d9e35d9499098cb0a0179"
}
```

新 runId 为 `shadow-CRWV-0001769628-26-000465-operator-fix-${UUID}`，使用同一 `FILING_OPERATOR_COMPLETION_WORKFLOW:runId` / `TASK_RUNS` 执行器；新记录 `reviewCalls` 只计新增请求，`reviewCallsInherited=7`，GET 的累计 `callsReserved`/`totalReviewCalls` 为二者之和，原记录保持 7。唯一纠偏 claim 是 `filing-operator:原失败runId:reviewer-correction`；相同 UUID/正文精确重放返回同一记录，不能重派发，第二 UUID、另一正文、纠偏再纠偏均拒绝。正文不接受新 quote、replacement、HTML、任意计划或成功回执。

正式入场前仍须回读原 failed7、公开 v6/hash 和新代码部署结果；本文件中的身份值不是线上请求或通过证明。成功只产生待独立人工审阅的 validated shadow，不自动 promote。

一次真实生产请求曾在同步重建阶段触及管理代理 30 秒上限：trace `3119b540d3282ad78d313c88c2a63bff`，管理端请求 `61efed756704c4646b6dcdf4f75801c0` 返回 503，`wallTimeMs=30000 / cpuTimeMs=2`；同 trace 的 analysis 请求 `def5b5cd638423449934bde20a7b9671` 为 `canceled`，`wallTimeMs=29429 / cpuTimeMs=745`。日志摘要为 `/tmp/spontra-crwv-real-shadow/reviewer-correction-503-log-summary.json`。根任务另行确认该次没有写入 claim、没有新增 provider 请求，原 failed7 与公开 v6 保持；503 不能描述成模型分析失败或新影子报告完成。

## 同一稿件的内容审阅定点纠错

既有 `apply-reviewer-corrections` 还接受一个实际已完成、失败的 `content:块ID` 回执。请求仍只有固定身份，不接受新作者文本或新计划：沿用 `expectedPlanHash`、`expectedFailedStateHash`、公开版本与 hash，并以 `expectedContentBlockId`、`expectedContentReceiptHash` 替代旧 semantic 身份字段。两种身份互斥；旧 semantic 请求和 metadata 保持兼容。

内容分支只允许原 run 的一个 major、一个块和一个唯一原句，应用审阅者实际给出的纯文本 replacement。原回执的 minor 意见、失败用量、源状态、计划和材料都保留；不得删句、插入 HTML、改计算、来源、研究采用理由或布局。原生 `apply_fixes` 的结果必须逐字等于这一个替换；metadata 明记 `sourcePhase=content:块ID` 与 `contentReceiptHash`，不把内容回执标为 semantic。完整大状态校验仍在 durable 非付费阶段，HTTP 不重新同步读取整套材料。

原 tools 不重放。修正后以实际 `prepare` 重新绑定文本 digest；仅原先完成且完整实际请求、块、来源、模型参数都相同的内容审核才可复用。未执行的块没有通过凭据，必须真实审核。首个 summary 在 1/12 时失败的情形，复用数量为零：六章内容、全文 semantic 和严格三视口 visual 都要新执行，正常需再 8 次、累计 9/12。入场前须有足够剩余额度覆盖这些步骤；所有 SDK 重试共用原 12 次上限，旧 1 次不得重置。

相同 UUID/身份只返回原 claim，不重派发；第二请求身份、递归纠偏、停止/中断状态、错回执或公开 base 变化均拒绝。源审阅 prompt 已改变时，旧成功输入 hash 不相同就不能复用；兼容旧 semantic 路径不等于豁免该证明。全文 semantic、严格视觉和独立人工 promote 仍为后续门槛。

本轮分类 prompt 变更后，新纠偏入场要求每个待复用内容阶段保留其实际原始 `inputHash`。没有原 hash 的旧 legacy 回执不能再靠当前 prompt 重建来证明历史一致；此前保存的离线复演仅保留为当时版本的历史证据，不改写它。

本地复验命令为 `SPONTRA_CONTENT_REVIEWER_CORRECTION_ACCEPTANCE=1 node scripts/filing-operator-completion-acceptance.mjs`，使用现有真实 proxy、AdminGateway、TaskRunner、原生工具和 Chromium；provider 返回明确为合成数据。结果另存 [内容纠偏旅程](results/filing-content-reviewer-correction.json)，不覆盖此前 semantic、预算、恢复和视觉证据。本段不是生产纠偏、真实模型结论或用户签核的证明。

另加 `SPONTRA_CONTENT_CORRECTION_BUDGET_ONLY=1` 只执行无截图的预算与历史 hash 反向旅程，结果为 [预算证明](results/filing-content-reviewer-correction-budget.json)：实际 1 次继承加 11 次新 HTTP 后，下一次发送被拦截；缺少旧实际请求 hash 的 semantic 复用入场也被拒绝。

最终主旅程 40/40、预算旅程 18/18 通过（均 exit 0）；共 55 次明确合成的 provider HTTP，54 张真实 Chromium 截图，真实模型与生产访问为 0。主旅程验证新内容纠偏累计 9/12、旧 semantic 在真实请求一致时累计 10/12；另测剩余额度不足、错身份、多 major、markup/缺失/删除 replacement、unknown/paused/stopped、公开 CAS、递归与重放，以及 semantic 或 visual 失败不能变成 validated shadow。历史 39 项和首轮预算结果另按 SHA 保存在 `/tmp`，本轮未重跑或覆盖旧 171/47/54/72/52 项证据。

## 按真实审核阶段单向推进的有界纠错

现有 `apply-reviewer-corrections` 允许已纠正内容的失败叶继续接受**更后阶段**的一条实际 reviewer plain replacement。固定顺序为 `content:summary → content:highlights → content:risks → content:overlooked → content:versus-prior → content:what-to-watch → semantic`。只允许严格前进；相同阶段、回跳、循环、对 semantic 纠错再纠错，以及 render、unknown、stopped 均不开放。每个失败叶仍只有一个原子 claim，精确重放不重新派发。这替代上节对所有纠错子稿一律拒绝的限制，不改变单句修改和独立审核门槛。

服务器最多遍历七个阶段的冻结父链，逐级核对不可变 source record、当前原始账本、实际失败回执、同一 plan/checkpoint/material/spec/root 和公开基准。纠错子叶须已有 `corrections done` 与 `prepare done`，原 tools 完整证明来自真实祖先，不能为子叶补造一个 tools 阶段。子叶继承数必须精确等于 `父.reviewCalls + 父.reviewCallsInherited`，并与 typed generation metadata 一致；所有 SDK 重试继续共享最初 12 次发送上限。

可复用内容仍必须完成真实审核。若父阶段自身也是复用，服务器沿同一冻结父链找到最初实际 provider 阶段，验证阶段 after-state 保存的回执、原始 before/after 状态、完整请求与块哈希、来源、模型/有效 effort 及实际 `ai_usage`，再调用原 `reuseContent`。不把中间复用回执伪称新调用；没有执行、没有实际 inputHash、请求改变或只有伪造 passed 标记都不能复用。每个新候选仍通过原 `apply_fixes` 单点替换和完整 prepare；全文 semantic 与严格三视口 visual 不复用、不跳过，人工 promote 保持独立。

例如原 content:summary 失败 1 次，纠错子稿 summary 通过而 highlights 失败新增 2 次，累计为 3 次。下一次只纠正 highlights：summary 的真实原始输入相同才复用，后五章、全文 semantic 与 visual 共需 7 次，最终正常累计 10/12。最低新调用数按真正 fresh 的阶段计算，不能拿子叶自身新调用数与内容阶段下标比较；已有复用 summary 的 risks 失败子叶可能只有 2 次自身调用、继承 3 次，该节点仍可按累计 5 次正确入场。

本轮本地命令：

```bash
SPONTRA_MONOTONE_REVIEWER_CORRECTION_ACCEPTANCE=1 node scripts/filing-operator-completion-acceptance.mjs
```

结果独立保存为 [单向纠错旅程](results/filing-monotone-reviewer-correction.json)，旧 40/18 项结果原样保留。它使用实际 proxy、AdminGateway、TaskRunner、原工具、composer stages 与 Chromium，只有 provider 响应为明确合成数据；不证明真实投资结论、真实视觉审阅或生产发布，也不代表用户签核。

本轮 91/91 项通过、exit 0：93 次合成 provider HTTP，108 张真实 Chromium 截图，真实模型和生产访问为 0。实际覆盖累计 `1 → 3 → 10`、内容纠错前进到 semantic 的 `1 → 3 → 9 → 12`、自有调用数低于阶段下标的 risks 叶 `1 → 3 → 5 → 11`，以及累计 3 次后只能再发 9 次的硬上限。错祖先账本/spec/hash、同阶段或逆序/循环、伪造通过回执、剩余额度不足、旧单 content/semantic 兼容、公开 CAS、重放、人审边界，以及全文 semantic 或 visual 失败不能发布均有实际正反向断言。Analysis 类型检查、定向 ESLint、脚本语法和 `git diff --check` 均通过；本轮未执行生产纠错或真实模型审核。

冻结改动后另执行 `npm run check`（包含边界、根目录/两应用类型检查及两应用构建）、`npm run analysis:typecheck`、Analysis dry-run，均 exit 0。全仓 lint 仍为原有 9 errors / 5 warnings；本次修改的 TypeScript 和旅程脚本定向 lint 为 0。本地检查不代表 Git CI、生产部署或真实报告审核已通过，后续逐项记录实际结果。
