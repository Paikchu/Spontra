# 财报外部作者完成路径：本地真实链路验收

本验收只验证完成路径、持久化与发布门槛。数据、旧失败检查点和所有模型响应均为合成内容；浏览器、报告组件、业务工具和服务执行链是真实实现。没有生产读写、真实模型调用、真实用户签核或部署。遵循根目录 `AGENTS.md`，以实际用户操作旅程验证，没有新增单元测试。

执行脚本：[filing-operator-completion-acceptance.mjs](../../../scripts/filing-operator-completion-acceptance.mjs)。机器可读结果：[filing-operator-completion.json](results/filing-operator-completion.json)。结果中的 `at`、`checks`、`transports` 与 `screenshots` 为本轮实际证据。

2026-11-17 03:50 UTC 最终运行正常退出（exit 0）：99 项全部通过，61 次合成 provider HTTP，48 张真实 Chromium 截图，真实模型调用和生产访问均为 0。成功路径本身为 8 次独立复核和 18 张截图；其余请求/截图用于负向与并发旅程。

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
