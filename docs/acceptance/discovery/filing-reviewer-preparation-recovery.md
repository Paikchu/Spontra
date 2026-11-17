# 一次显式、未计费 preparation 恢复：本地专项验收

执行入口为 [filing-operator-completion-acceptance.mjs](../../../scripts/filing-operator-completion-acceptance.mjs)，专项结果独立保存为 [filing-reviewer-preparation-recovery.json](results/filing-reviewer-preparation-recovery.json)。未覆盖历史 171、异步 47 或缓存 54 项结果，也未重复这些宽旅程。

最终专项记录于 `2026-11-17T05:43:18.859Z`，进程 exit 0，72/72 项通过：45 次全合成 provider HTTP、18 张真实 Chromium 截图、真实模型及生产访问均为 0。最后执行的断言显式要求非空 old-owner state put；本结果不是只检查 `every` 的先前版本。

```bash
SPONTRA_PREPARATION_RECOVERY_ACCEPTANCE=1 \
  node scripts/filing-operator-completion-acceptance.mjs
```

材料和模型响应为合成数据；处理器、同源代理、命名 AdminGateway、TaskRunner、RunStep、实际工具、composer、Chromium 和 artifact-frame 均是真实实现。没有生产访问、真实模型调用、部署或真实用户签核。

## 实际超时与两个版本的旧 callback

fixture 只将目标旧 TaskRunner 的原生 `setTimeout(660000)` 加速为 1000ms，且只在其上一阶段已完成 `operator:corrections` 时生效；没有伪造 timeout 文本、通过回执或 runner FINAL。RunStep 仍用自身的 660000ms 配置计算错误，实际生成 `step operator:prepare timed out after 660s`。真实 R2 index get 已读取对象，再在 prepare 阶段保持返回未完成；原任务实际变为 `unknown/prepare/new0/inherited7`，其 TaskRunner `status()` 实际为 `errored`。没有等待真实 11 分钟。

旧 execution 432 使用完整历史 `82a0d391a4b54c49a4fd2ceaf2385f9fae80899c` 的 `operator-completion.ts`，源 SHA-256 为 `f6df75d8b5c5fa87d43d0c802c8f76140ea157cc6585880c57575f2d01af6f78`。esbuild 虚拟模块按当前 filing-analysis 目录解析依赖；仅本地 tasks mapper 对这个旧 execution 选择历史函数，恢复 suffix execution 使用当前函数。该旅程验证的是实际旧 operator 函数与当前依赖，不冒称重建了整个旧部署。

旧 execution 436 使用当前函数，重复检验当前 epoch、bootstrap、SDK gate 与迟到 fence。两条路径的实现选择、原生 timer 记录、真实旧 runner 错误终态均保存在结果中。

## 恢复与拒绝门槛

真实入口为 `POST /api/admin/reports/TICKER/ACCESSION/shadow/同一runId/recover-preparation`。正文严格只接受 `expectedRecordHash`、`expectedPlanHash`、`expectedPreparationStateHash`、`expectedPublicVersion` 和 `expectedPublicHash`，上限 8 KiB，必须有 UUID 幂等键。

请求必须对应精确未知 prepare 超时、已完成 corrections、`reviewCalls=0`、没有付费阶段以及旧 runner 真正 `errored/terminated`。记录、原计划、已完成 correction state、原公开版本/哈希全部绑定。恢复保留同一 operation、shadow、原预算和来源，新 execution 为 `${runId}-preparation-recovery`，唯一 claim 不允许再次派发；原超时记录、失败对象与 corrected state 均按原字节归档。

已实际验证：

- active preparation、已发生内容请求的 unknown、确定性坏证明 failed、明确 stopped 均拒绝，拒绝不产生额外 provider HTTP。
- 未授权、跨来源、非 POST、无 UUID、错误身份哈希/版本、额外 HTML/plan/state/executionId/maxCalls、过大正文均拒绝。
- 相同请求并发只认领一次，新 execution 参数仍为同一 `runId`，没有新建 shadow、重新执行 `apply_fixes` 或启动作者会话。
- 精确重放不再次派发；另一 UUID、改变身份均拒绝。原 corrected `afterStateRef` 和完成阶段原字节保留。
- 新 execution 已进入 `content:summary` 且 provider 响应仍在途时，实际旧 bootstrap 被拒，旧 epoch 即使带新 lease 也无法保留额度或发送 HTTP。

## 迟到旧代码的强证据

两条路径均在新 summary 请求仍 held、记录仍 active 时释放旧 prepare 的 R2 返回。除了 worker 中的实际 returned-read 标记，还必须观察到**至少一次**释放后旧 owner 的 `/states/` put，证明 callback 已实际走到 `writeState/live` 边界；不能用空数组的 `every` 冒充检验。

随后逐字比较新 active 原始 D1 行、execution/lease、common 原超时失败对象和 artifact versions，确认它们不变，provider HTTP 也不增加。旧函数确实可能写入无引用的内容寻址 state 对象；结果完整记录这些孤立对象。它们没有改变有效状态、失败回执、validated 指针、报告版本或公开指针，不能描述成“没有任何 R2 写入”。

历史 82a0 路径随后只完成 summary 内容、完整语义和三视口视觉三个新增请求，得到同一 runId 的 `validated_shadow`，累计新 3 + 继承 7 = 10/12。原失败 7 次及公开 v6/hash 保持不变，作者自审仍被拒。当前旧函数路径通过实际 SDK 再消费剩余额度，验证新 5 + 继承 7 达到 12 后不能发送下一语义 HTTP，也不能验证或重置预算。

本专项只证明恢复和并发隔离机制，不证明真实模型的财务判断或视觉判断质量；validated shadow 仍需要独立人工审核，未自动公开。
