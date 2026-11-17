# 行业外部作者草稿保存验收

基线为 `4cded493`，2026-11-17 UTC。此节点接续现有未提交实现，只增加受限的行业草稿保存路径，不启动模型、恢复任务或发布报告。仓库未发现 `.agents/skills`；遵循 [AGENTS.md](../../../AGENTS.md)，使用真实本地 Cloudflare 操作旅程，不编写单元测试。

## 允许的写入

`POST /api/admin/public-research/reports/:id/operator-complete` 经管理站同源检查及命名 `AdminGateway` service binding，进入认证后的 [admin handler](../../../workers/analysis/src/public-research/admin.ts)。真实行业草稿含 27 条结论、19 份来源，首轮 compact JSON 为 134,731 字节（移除无关段落后的最终稿为 120,795 字节），略超 128 KiB；不能为 HTTP 上限删去支持证据。代理仅为此精确 POST 路径扩展至 256 KiB（262,144 字节），仍检查实际 UTF-8 字节数。常规 revise 与 reconcile-source 均保留 128 KiB。

[保存实现](../../../workers/analysis/src/public-research/store.ts) 要求以下条件同时成立：

- 同一行业报告、scope、语言；原任务账本为 stopped，存储 RPC 确认 runner 为 terminated 且所有会话不活跃；父 synthesis 已完整提交，完整内容哈希与请求、失败增量入场一致。
- 增量任务为 failed/review_failed，且无最终 `result_version` 或其 fingerprint 对应的已存草稿；同报告没有 queued/running 任务。
- 新稿逐来源具备审计说明，满足 schema、来源摘录 SHA-256、日期、claim/observation 引用检查；采用的宏观 claim 必须来自增量任务冻结的精确已发布版本，未撤回、未失效、未过期，发布时间及数据截止时间均不晚于新稿 asOf。
- 新稿使用独立 fingerprint、`operator-*` 作者与 `operator-completion.*` 提示版本，保留真实 `modelVersion`；外部作者 `gpt-6.1-sol` 不依赖应用内模型注册表。

接口复用 `saveDraftWithAudit` 和已有 `0063_public_research_revisions` 审计表，将回执、版本索引、claims 索引放入同一 D1 batch。它只保存全新未审阅 draft，明确返回 `humanReviewRequired: true`，保留原失败任务、原来源及既有公开版本。行业报告继续通过原有独立人工审阅和显式发布路径；本接口不提供批准或发布捷径。

## 实际验证

可复跑命令：

```sh
node scripts/industry-operator-completion-acceptance.mjs docs/acceptance/discovery/results/industry-operator-completion.json
```

[操作脚本](../../../scripts/industry-operator-completion-acceptance.mjs) 使用合成材料，实际运行管理站 handler → proxy → 命名 `AdminGateway` → 认证分析 handler → TaskRunner 存储 RPC → D1/R2。详细结果见 [JSON](results/industry-operator-completion.json)。68 项检查全部通过，覆盖：

- 认证、同源、方法及额外路径；大于 128 KiB、小于 256 KiB 的完整来源正文经真实代理保存及读回；超过 256 KiB 拒绝。常规 revise/reconcile 在 64–128 KiB 仍进入 schema 校验，超过 128 KiB 仍拒绝。
- 错父任务/哈希、活动 runner/会话、scope/语言变更、已完成失败增量、缺失/重复/错误 source audit、错误 schema/hash/time、未来来源、未冻结/重复/撤回/失效及晚于截止时间的宏观依赖均被拒绝。
- 真实 D1 trigger 在版本索引写入时强制失败：整个 batch 的 audit、version 和 claim 索引全部回滚，没有孤立数据库版本。
- 两个并发相同 payload 返回相同的首个回执；并发的精确重放与冲突内容保留唯一胜者；完成人工审阅后的精确重放不改变 review。
- 未审阅稿不能发布；原 run 账本及 63 次已预留调用、停止 runner 的完整存储、公开指针和父 checkpoint 字节均未变化；外部请求为零。

全仓、Analysis、Admin 类型检查及定向 lint 通过；Analysis 与 Admin Wrangler dry-run 通过。全仓 lint 为既有 10 errors / 5 warnings，本接口及验收脚本没有新增 finding；既有问题溯源见 [lint-provenance.md](lint-provenance.md)。最终精确提交的 CI 与生产验证仍由发布节点执行。

## 验证边界

本节点没有提交、推送、部署或生产写入，不能据此声称生产保存接口已经上线；没有生成真实行业内容或代替用户人工审阅。本地未配置 Cloudflare Access，验证的是实际管理站代理、service binding 和分析端认证链。

R2 与 D1 不共享事务：不可变完整正文先写入 R2，随后 D1 原子提交索引与审计。索引失败可能留下未引用的完整 R2 对象；旅程实际验证该对象不可通过报告版本索引读取，原公开版本不变。此次没有增加清理任务或变更旧报告。
