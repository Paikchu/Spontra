# G8：财报投资影响的精确版本与共享结果

2026-11-17。本节点使用合成材料、本地 SQLite / 对象存储、实际生产函数和 Chromium 用户操作。没有新增模型调用、生产写入、报告批准或部署。基线检查提交为 `4cded4933dcef5b68688f079124db32b5abc2cc4`，本轮代码由主任务统一提交和发布。

## 修复的实际缺口

01:04:56 UTC 对生产 CRWV `0001769628-26-000465` 的只读 Chromium 检查显示：财报摘要和估值页共同使用公司旧估值 `f81defe0289ba65cd7030ecd5a065260`，研究截至 11 月 15 日，冻结价为 11 月 13 日的 $53.13，更新行情为 11 月 16 日的 $49.88。页面正确说明没有条件可比的事件前后模型，但新 10-Q 的 `investmentChains` / `impactComputations` 没有进入这两处共享读取；新影子通过或晋升本身不会补全该链路。该现场是本轮开发前的基线，不代表发布后的状态。

## 本节点实现

- [filing-impact.ts](../../../shared/analysis-contract/filing-impact.ts) 定义 `FilingImpactPublication`，绑定 ticker、accession、源 artifact 版本及 canonical hash、材料版本、财务期间、研究时点和语义审阅凭据。金融敏感性与事件每股价值分别表达。
- [impact-publication.ts](../../../workers/analysis/src/filing-analysis/impact-publication.ts) 只接受实际通过 `finish` 的本次状态，在 `onShadow` / `onPublish` 保存不可变结果。结果按内容寻址，`sec_cache` 指针只插入；相同重放复用，不同工作状态不得覆盖。不会读取可变 `work.json` 为历史报告补造结果。
- 原始数值、披露单位、打印文本、期间及来源 URL 从同一冻结 `MaterialSnapshot` 保留；详细页并列展示原文 `16400 USDmillions` 和计算输入 `16,400,000,000 USD`。缺少 typed unit provenance 的旧 impact calculation 必须重算，不得仅改文字。
- 财报摘要和完整估值页读取同一 `resultId`，旧公司估值单独折叠。摘要只呈现短预览、已计算结果和缺口状态；完整假设、传导、反证、验证时间、输入表和来源在详细页。原文不通过切句重写成新结论。
- 桌面摘要最多两条链，手机先显示首条及完整入口；长文字最多预览两行，能展开原文。缺口数量与“暂不可量化”状态保留。
- 事件 `eventChange`、事件模型及冻结事件报价保持空值，列出缺少的受控前后模型、税务、经济股数、估值桥接与报价日期。没有拿旧公司估值或静态利息敏感性生成事件目标价。
- 翻译保留源 `sourceHash`，与译文 HTML hash 分开。公共依赖失效时保留已保存结果和原证据，暂停派生财务与估值输出；详细页复用既有公共研究版本 / claim 阅读组件。

## 公开读取与历史兼容

新公开财报精确读取必须同时给 `artifactVersion` / `artifactHash`。不匹配、缺字段、草稿、伪造预览均拒绝，不替换为当前报告。预览只能使用既有签名 token；加载中与失败有明确状态，不回退旧公开 HTML。

`saveVersion` 现在始终写 draft。原子 `publishStatements` 批次才标为 published，同时记录精确版本 / hash 的 publication 凭据。替换旧 current 时，仅为其确切指针补凭据。新公开历史入口只接受当前精确指针或已提交的 publication 凭据，旧状态被误标为 published / superseded 的孤稿不能借此公开。

私有用户已保存 snapshot 仍沿用 `readArtifactEdition` 的原兼容读取；新公开入口显式启用 `requirePublicationProof`。未知旧 superseded 没有被批量补凭据。旧 `reportVersion` 的 SEC 摘要读取仍保留；没有精确 artifact 版本时不再把当前 HTML 混进旧摘要。

显式侧栏导航会清除上一稿的版本 / 预览参数，浏览器后退可恢复原精确对象；刷新不清身份。公司估值参考链接保留已选个人敏感性 ID，并绑定该敏感性返回的基准模型版本；身份或基准不匹配时不携带 ID。

## 实际验证

1. `node --experimental-strip-types --no-warnings scripts/filing-impact-publication-acceptance.mjs`：**31 项通过**。[结果](results/filing-impact-publication-journey.json)。使用全部实际本地 schema、`filingLoader → finish → onShadow`、sidecar、Analysis 读取 handler 和业务 BFF。完整缓存语义审阅结果与 render 边界结果为合成 fixture，不等于真实模型审阅。
2. 正反向包括：单位恢复、结果校验和、同状态重放、不同状态拒覆盖、旧单位缺凭据拒绝、签名 / 伪造 / 过期预览、草稿已知 hash 拒绝、中文 canonical 身份、依赖失效、历史 / 当前隔离。
3. 实际 normal `filingLoader → finish` 分别注入 `onPublish` sidecar 失败和原子发布事务失败：候选仍为 draft，无 publication 凭据；已知 hash 无法公开，后续成功也不把失败稿变为历史公开稿。旧 current 切换后可读，未知旧 superseded 公开拒绝、原私有 snapshot 兼容保留。
4. 本地 Vite 与实际本地读 handler：**17 组 Chromium 用户旅程通过**。[结果](results/filing-impact-browser.json)。覆盖 1440×900 英文与 390×844 中文、摘要到详细页同结果、刷新 / 后退、单位表、键盘 / 滚轮到底和返回、无横向溢出、无 pageerror；另覆盖报告级预览加载 / 伪造 / 空 token、三种侧栏换文件、私人敏感性基准匹配、失效依赖、旧稿缺结构、桌面 / 手机千字长链。长链在展开前正文起点进入首屏，原文仍可展开。
5. 本节点修改范围 ESLint 0 errors / 0 warnings，business-site / Analysis 类型检查通过，业务站构建通过；主任务仍须对最终合并树统一执行全部检查。Analysis dry-run 初次因默认日志目录不可写失败，改用 `XDG_CONFIG_HOME=/tmp/spontra-g8-wrangler-config WRANGLER_SEND_METRICS=false npm run analysis:check` 后通过，没有请求权限或远程写入。

复现浏览器：先运行上面的 publication 脚本并附加 `--serve`（仅本地 `127.0.0.1:8796`），再用 Vite 在 `127.0.0.1:4208` 启动业务站，运行 `node --experimental-strip-types --no-warnings scripts/filing-impact-browser-acceptance.mjs`。公司 opening 为仓库合成 fixture；精确报告 / 预览请求进入实际本地 handler。长链是明确的合成 UI 压力输入，不是生产研究。

## 未完成的真实内容关卡

本记录没有把本地旅程当作真实 CRWV 内容通过。CRWV 有界续作必须产出通过单位与独立语义校验的影子，核对实际引用的宏观 / 行业版本，并完成仍适用的公司报告人工审阅后才能晋升。发布后须回读精确提交、部署、真实报告和共享结果；这些由主任务追加实际证据。

没有受控前后模型和所需金融输入时，事件每股价值仍应保持不可量化。NBIS 公司报告未生成。本节点没有修改或豁免原始需求。
