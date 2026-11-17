# 有界财报 shadow 续作

本入口用于保留预算耗尽后的完整财报草稿与取证上下文，仅创建一次新增 40 次请求的子 shadow。它不调整父任务预算，不重启父任务，不自动发布，也不替代财报的人工审核。

## 只读检查

管理员读取：

```text
GET /admin/reports/:ticker/:accession/shadow/:parentRunId/checkpoint
GET /api/admin/reports/:ticker/:accession/shadow/:parentRunId/checkpoint
```

分析服务接口使用现有管理员认证；第二条通过现有管理站点服务绑定转发。GET 返回完整 `checkpoint`、`checkpointHash`、`readOnly: true`、`reviewStatus: unvalidated` 和 `published: false`。

- 只从已保存的 D1、R2 和 TaskRunner SQLite 读取。不调用 `report()`、恢复任务、模型、hydrate、材料采集或宏观刷新，也不为 GET 写入 checkpoint。
- RPC 为同步方法，避免 Agents SDK 自动为自定义异步 RPC 启动 lifecycle；已结束独立 shadow 的冷启动也不安装 Pi lifecycle。
- 要求自然失败回执存在、没有 validated 回执、所有会话 inactive，并核对 operationId、filing kind、完整 admitted spec、session/job/ticker/accession/material 和保存文档身份。
- `state` 是完整 `packState` 字符串；Map、Set、原文、证据、六个或更多报告块、计算和投资链均保留，没有 4,000 字符裁剪。
- SHA-256 覆盖返回的完整 `JSON.stringify(checkpoint)`。没有新数据和时间字段进入同一次状态读取，因此相同状态的 hash 稳定。

单独的 `active: false` 不证明预算自然耗尽。GET 仍可导出其他未验证的已结束失败草稿，供排查；POST 的准入更严格。

## 创建唯一子任务

```text
POST /admin/reports/:ticker/:accession/shadow/:parentRunId/resume
POST /api/admin/reports/:ticker/:accession/shadow/:parentRunId/resume
idempotency-key: <新的 UUID>
content-type: application/json

{
  "expectedCheckpointHash": "<已实际检查的完整 checkpoint SHA-256>",
  "reason": "<本次定向续作的非空理由>",
  "includePublishedIndustry": false
}
```

管理站点写入沿用同源检查。`includePublishedIndustry` 可省略，默认 `false`，保留原冻结背景。请求不接受新 model、effort、材料、宏观版本、预算或任意覆盖状态。

显式设为 `true` 时，只读当前公司的已验证业务敞口映射，保留父全部原 ID/版本，只允许追加此前不存在的已验证 exposure ID；禁止替换、换版或移除原映射。新增映射的原文 excerpt 必须存在且与 source hash 一致，发布时间、可用时间、采集时间及映射有效期不能超出 child as-of。沿用来源已记录的权重，未知权重保留 `null`，不推算业务占比。逐项确认父任务已采用的精确 claim 现在仍已发布、有效且发布时间不晚于子任务 as-of。

仅追加目前已发布、人工审核通过、整体有效并符合有证据映射的新行业报告 ID；未发布草稿、仅已审核未发布、失效、未来版本与已有报告的新版本均不能加入。没有符合条件的新增行业会拒绝请求，不会创建相同背景的新任务。

追加保留父 `reports` 和 `mappingVersions` 的完整前缀、每个精确版本及 `public1c…` 等 source ordinal；不替换、更新或重排既有宏观与行业版本。新 context 记录现在的 `asOf`/`frozenAt`，只去除新行业已覆盖或新映射已实际解决的对应缺口，保留其余缺口。回执和子 spec 记录 `parentContextHash`、`newContextHash`、`childContextAsOf`、`addedMappingVersions` 与新增报告 `reportId/version/publishedAt`。这是新子结果的增量背景，不能声称父任务原 140 次调用已经读过新行业或拥有新映射。相同 UUID 不能通过改变此开关切换续作范围。

只有带增量背景的新子 recipe 初始 `open()` 重置 `publicResearchRead=false` 并清除旧 composer context 元数据；保留原 `researchUses`、`publicClaimsRead`、原报告块和源 ID。模型需要实际读取新 context index、新行业 claim 并记录公司适用性决策。只读目录、只读 claim 或没有新行业决策时，真实 `finish` 都会拒绝。冷恢复的 hydrate 不会再次重置已完成的阅读和决策。

新续作还要求：父任务已经用尽原预算，保存的 session `capped=true`、`finished=false`、`startupPending=false`；未停止、未验证、未发布；原 model 和 effort 已显式固定；父任务本身不是 continuation。真实历史父任务必须先读回确认这些值，不允许为满足准入去修改父行。

服务端将完整状态以内容寻址、不可覆盖的对象保存到：

```text
research-shadow/:parentRunId/checkpoints/:checkpointHash.json
```

随后在一个 D1 batch 中插入父任务唯一 claim `research-shadow:<parentRunId>:resume` 与新 child 元数据。父元数据在 claim 前发生变化会拒绝请求。每父最多一个子任务；并发和重复 UUID 请求都不能再派发一次。子任务继承原冻结 filing、材料、model、effort 和 baseVersion；背景默认完全继承，只有显式启用上述选项才追加行业。原父 checkpoint 和失败回执不会改写。

精确重复 UUID、hash 和 reason 时回读已有回执；不同 hash、reason 或 UUID 返回冲突。回执状态：

| 状态 | 含义 |
| --- | --- |
| `claimed` | 唯一 claim 已保存；派发确认尚未保存，结果可能不确定，不再派发 |
| `dispatched` | 启动已获确认；读取子任务继续观察 |
| `dispatch_failed` | 派发失败或确认不确定；claim 与失败回执保留，相同请求也不会重试派发 |

派发失败后保持父失败回执、父 140 次计数及公开报告原样。checkpoint 对象与 D1 不共享事务，若 D1 准入失败，可能存在无引用的完整 checkpoint 对象；不会因此产生第二个模型任务。

## 预算和定向修复

子任务最多 40 次新增模型 HTTP 请求。Pi 的主模型、自动重试和 compaction，以及块审阅、OpenAI 独立语义/渲染审查，都通过同一 D1 原子计数。子 recipe 和 composer 的 turn budget 同时固定为 40，避免向模型显示原父任务的百余 turn。

原父任务的 140 次计数保持原 Pi-provider 范围，不追溯把旧辅助审查加到父计数。审计记录同时保留 `parentCallsReserved`、`parentMaxCalls` 与 `cumulativeMaxCalls=180`；180 是两代准入额度之和，两代的统计范围不同，不代表历史上所有模型 HTTP 请求的总数。`ai_usage` 和 Pi usage 仍是另行记录的供应商已报告 token 用量，不能当作实际金额账单。

严格预算拒绝 HTTP 后会安排既有 recovery wake。`poll()` 与 `recoverEnded()` 共用对 capped strict operation 的 SDK abort，针对该 operation 停止无效重试并保留草稿。afterRun hook 与 recovery 共用一次性结束路径，避免重复 afterRun；非 strict 任务不走此预算分支。

续作 opening 要求复用已保存证据，仅定向检查缺口；旧影子中的单位、投资链和推断都属于未验证内容：

- 旧 `impact1=82 USD` 不能支持“8,200 万美元”；需要按真实原始单位和 typed provenance 重新计算，不能直接重命名旧结果。
- 优先保留公司披露的实际三个月、九个月利率敏感度窗口。若原文是每 100bp 4,100 万/1.23 亿美元，不能无条件年化为未来净利息；net-of-hedge 口径未知时不能再扣互换。单独的一年/20bp/50bp 情景须明确为静态假设，固定存量票息不能随市场收益率重定价。
- 可取消不等于已取消、已退款或退出 RPO；退款现金、收入履约和时点不能未经证据一比一扣减。
- 现有股东减持不等于发行人融资或稀释，不能机械限制内在价值。
- 对过时投资链必须重新记录或移除引用，不能只改 HTML。原宏观冲击不能在多个研究层重复计价。

原 finish 的完整独立审计、数据/来源检查、渲染检查和人工 promote 门槛全部保留。子任务再次失败仍保存草稿，不能再 resume；必须如实报告剩余问题。

## 本地用户操作验收

```bash
node scripts/filing-shadow-resume-acceptance.mjs
node scripts/public-research-checkpoint-acceptance.mjs /tmp/public-checkpoint-regression.json
node --experimental-strip-types scripts/public-research-budget-acceptance.mjs
npm run analysis:typecheck
npm run admin:typecheck
```

主旅程在真实 Miniflare 中经过管理站点 handler/proxy、服务绑定 AdminGateway、TaskRunner/PiHost、filingLoader、D1/R2 和安装版本的 Pi/OpenAI 客户端。所有 provider HTTP 都拦截为本地合成响应，没有真实模型、生产、提交或发布调用。检查冷读与错误状态的零模型调用、完整状态/hash、身份/来源版本、单 claim/幂等/并发、40 次共享预算、重试、派发失败、checkpoint 篡改与父/公开版本不变。

G5 增量背景旅程还经过真实 publication store，覆盖未发布、失效、未来版本、已有映射换版/移除、无来源/来源 hash 错误/未来/未验证的新映射、空映射追加新验证 ID、父已采用 claim 失效、双哈希、保留旧宏观版本、源 ordinal、范围幂等及真实 finish 拒绝未读/未决策。全部使用合成审查记录，没有代替用户对生产报告签核。

实际执行结果见 [filing-shadow-resume.json](results/filing-shadow-resume.json)。代码能力与合成验收不代表真实报告已经通过语义、渲染或人工审批；真实父任务资格、实际新增用量和生产行为仍需上线后的独立读回。
