# 财报外部作者完成路径：本地真实链路验收

本验收只验证完成路径、持久化与发布门槛。数据、旧失败检查点和所有模型响应均为合成内容；浏览器、报告组件、业务工具和服务执行链是真实实现。没有生产读写、真实模型调用、真实用户签核或部署。遵循根目录 `AGENTS.md`，以实际用户操作旅程验证，没有新增单元测试。

执行脚本：[filing-operator-completion-acceptance.mjs](../../../scripts/filing-operator-completion-acceptance.mjs)。机器可读结果：[filing-operator-completion.json](results/filing-operator-completion.json)。结果中的 `at`、`checks`、`transports` 与 `screenshots` 为本轮实际证据。

2026-11-17 04:33 UTC 最终运行正常退出（exit 0）：171 项全部通过，107 次合成 provider HTTP，66 张真实 Chromium 截图，真实模型调用和生产访问均为 0。包含原完成路径的 99 项检查及新增的复核意见修正旅程。原成功路径为 8 次独立复核和 18 张截图；修正成功路径新增 3 次复核和 18 张截图，其余用于负向与并发旅程。

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

其余五块通过 `reconstructedLegacy-v1` 重建原始完整模型请求。验收逐块核对 `reusedFrom` 的来源 run/phase、真实 before/after state 引用、原成功回执哈希、完整 `inputHash`、`blockHash`，并以 SQL 查到同一时点、阶段、模型、推理配置且 `outcome=ok` 的实际 `ai_usage` 行。新请求中的 HTML、标题、来源文本、已通过句子或建立的事实发生变化时，不允许凭旧 passed 标志复用。

成功路径实际只发送三次新增 HTTP：summary 内容复核、包含全部六块与完整材料的语义复核、所有三视口的严格视觉复核。其余五块没有新增内容模型请求，新的 validated shadow 保存了原计划与 reviewer-correction 来源信息。GET 明确返回 `reviewCalls=3`、`reviewCallsInherited=7`、`callsReserved=10`、`maxCalls=12`；原失败任务仍是 7 次，未被改成成功。

新增负向旅程已实际执行：

- 身份哈希或公开版本错误、额外 HTML/plan/quote 等八类字段、过大正文、非语义失败、没有精确 quote 的语义失败均拒绝。
- 篡改原成功用量行的模型、改变未修正块 HTML、改变来源证据文本，都在新模型调用和正式认领前拒绝；故障注入后恢复原记录。所有这些拒绝均为零新增 provider HTTP。
- 同时提交相同请求只形成一个认领和一个确定性任务；精确重放零新增请求，不同 UUID、改变身份或对修正版本再修正均拒绝。
- 修正任务继承原 7 次，只能再占 5 次。用真实 `judge` SDK 消耗剩余额度后，合计 12 次即阻断下一语义 HTTP，不允许重置为新的 12 次。
- 修正任务在实际 changed-block HTTP 在途时冷重启、lease 失效或显式停止，迟到成功不能验证，也不会自动重发。作者自审与自动公开均被阻止。

结果 JSON 的 `reviewerCorrection` 单独记录原 7、新 3、累计 10 及五块复用证据。修正版本保持待人工审核影子状态；文中最后的独立模拟 promote 是对原完成路径的隔离验收，不代表用户批准这份修正版或任何真实报告。

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

## 本轮真实纠偏的入场身份（尚未执行）

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
