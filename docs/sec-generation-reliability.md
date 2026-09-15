# SEC 报告生成可靠性

目标：新版本的有效生成请求，在 24 小时内通过完整性、证据与财务校验并发布；最终失败率低于 1%。一次请求内部的续写、修复、模型切换和 Workflow 重试不另计成功样本。旧报告继续可读不等于新报告生成成功。

## 故障处理

| 故障 | 处理 | 仍保留的校验 |
| --- | --- | --- |
| SSE 累计超过旧 2 MB 限制 | 分开统计传输、正文、推理；边读边丢弃包装及推理文本 | 独立资源上限、有效进展停滞检测 |
| provider 返回 `finish_reason=length`，连接中断或停滞 | 将正文前缀保存到 R2；关闭 JSON 模式续写缺失后缀；提高 token 预算 | 完整终止标志、整个 JSON 解析、后续证据与编辑审核 |
| JSON 格式错误 | 带上已生成草稿修复；重复错误切换模型 | 不从坏 JSON 中截取一个看似可用的内部对象 |
| 图表遗漏、无图说明遗漏、标签不匹配、无效或重复图表 | 只回退对应展示配置，保留全文、证据和有效图表；记录诊断 | 不编造数据点或把缺配置说成公司未披露 |
| HTTP 408/429/5xx | 退避并切换配置中的主模型/Hy3；尊重 Retry-After，最长等待五分钟 | 401/403/404 不盲目重试；具体失败单独记录 |
| provider 不接受输出预算或 JSON 模式 | 根据拒绝信息协商预算，或去掉 JSON 模式再走本地严格解析 | 不放松业务校验 |
| Workflow 结果超过 1 MiB | 大于 512 KiB 的结果存 R2，步骤只保存带 SHA-256 的引用 | 恢复时验证完整性；读取短暂失败可重试 |
| 长任务被定时重复启动 | 有效生成期间每 30 秒续期任务；Cron 合并已有运行；查询优先返回仍有效的运行任务 | 过期任务仍可恢复，不让失败任务永久锁住公司 |

模型断点按 Workflow ID、阶段和输入/提示词指纹隔离，避免跨公司、跨期、跨修订复用。正文每新增 32 KiB 或生成正文期间间隔 30 秒保存；失败时再次保存。仅推理期间续期任务，不持久化推理内容。R2 检查点短暂不可用会记录诊断，当前进程继续恢复；跨进程恢复依赖成功保存的检查点。

## 预算与余量

| 项目 | 新预算 |
| --- | --- |
| 首次响应 | 90 秒 |
| 连续无有效正文/推理 | 60 秒；心跳与空白不算进展 |
| 单个 Workflow 模型步骤 | 60 分钟，内部执行预算 59 分钟 |
| 每次请求输出预算 | 默认 65,536 tokens，截断后逐步提高至模型允许的上限；Hy3 128,000、Qwen3.8 131,072 |
| 一次步骤中的恢复调用 | 最多 6 次，共享执行预算；外层保留持久化重试 |
| 原始传输累计 | 256 MiB；不整体缓存 |
| 保留的正文 | 8 MiB |
| 推理累计 | 64 MiB；只计数，不保存正文副本 |
| SSE 单帧/待完成帧 | 1 MiB；不接受无限增长的无换行帧 |
| 读者文章硬上限 | 16 节、每节最多 8 段、全文 96,000 字符；常规报告仍按阅读需求控制篇幅 |

能力参考：[B.AI Qwen3.8-Flash](https://docs.b.ai/llmservice/models/qwen3-8-flash/)、[B.AI Hy3](https://docs.b.ai/llmservice/models/hy3/)、[Chat Completions 参数](https://docs.b.ai/llmservice/api/)、[Cloudflare Workflows 限制](https://developers.cloudflare.com/workflows/reference/limits/)。文档上限不是实际请求必然可用的额度，HTTP 拒绝会触发协商。

## 测试与线上验收分开

`tests/pipeline/sec-generation-recovery.test.ts` 覆盖 500 组确定性故障注入案例：变化的截断位置、UTF-8 切分、响应截断、服务错误、展示缺项，并逐项比较恢复前后的段落和证据。另有资源边界、身份认证错误、JSON 修复、断点跨调用恢复、Workflow 大结果/损坏校验与不允许伪造证据的反例。这是工程回归，不代表 provider 的实际失败分布。

线上使用 `sec_analysis_jobs` 中新发布之后创建的请求统计。`complete + published` 才计成功；最终 `failed` 或超过 24 小时仍未完成计失败；尚未到期限的运行请求单列，不以排队/重试状态掩盖失败。按 job ID 去重，不按尝试次数计算。

```sh
npx wrangler d1 execute earning-report-analysis-sec-web --remote --config workers/pipeline/wrangler.jsonc --command "SELECT job_id,status,current_stage,error_code,created_at,updated_at FROM sec_analysis_jobs WHERE created_at >= 'RELEASE_UTC_SQL_TIMESTAMP'" --json > /tmp/sec-generation-jobs.json
node --experimental-strip-types scripts/sec-report-reliability.ts --input /tmp/sec-generation-jobs.json --since RELEASE_ISO_TIMESTAMP
```

替换占位时间为实际发布 UTC 时间；如只验收完整财报，导出时限定对应的 10-K/10-Q/20-F 请求。脚本退出码：0 为样本支持目标，1 为观察失败率超标，2 为样本不足或存在未完成请求。输出包括请求数、成功/失败/逾期/待完成数、失败分类，以及单侧 95% 精确二项上界。

零失败至少需要 299 个独立生产观测，才能让单侧 95% 上界低于 1%；仍须覆盖不同公司、报告复杂度、模型和多个时段。关联故障、单一公司反复重跑、合成案例不能替代代表性线上样本。至少观察完整 7 天，按模型和失败分类检查 `sec-model-request`、`sec-model-recovery`、`sec-report-generation` 日志，再验收总体目标。不能通过移除财务/证据审核或把旧报告标作成功来降低失败率。


## 内容审核与局部修订

写作前提供 `requiredTopics`，其中含高重要性问题、验收条件、证据和 Manager 的回答状态。写作与最终覆盖检查共享同一计划；主题未知时说明检索范围、缺口及其影响，不用虚构事实满足清单。

初稿保存在按 Workflow ID 和修订轮次隔离的 R2 路径中。结构检查报出具体遗漏 ID 和问题，携原稿请求局部补丁。补丁只允许替换指定章节、追加章节及同步读者结论；拒绝删除原有主题、无效章节 ID 和整篇替换。未涉及章节由程序保留。结构纠错最多三次，正文审核后最多四轮修订；第二轮起使用备用模型。每次修订单独持久化，再作全文审核。保存失败会阻止该步骤完成，不能伪称具备可恢复的草稿。

审核返回稳定问题编号、类别、严重性、具体原句、章节、证据和通过条件。审核提出的事实不是新的证据：未引用有效来源的事实纠正改作证据问题，修订时回查同一 filing 中的原文。只涉及版式的建议不阻塞发布；数字、因果、证据与重要覆盖问题仍然阻塞。审核同时看到前端确定性生成的 FCF 计算框，不能要求正文机械重复，也不能将标准 FCF 趋势当成两种口径对比。

现金流事实可携带分类、是否包含在 OCF、履约义务和原文摘录。摘录必须能在相同 evidence ID 对应原文中匹配，才展示提取的分类；否则保留未知。`quoted` 只代表摘录匹配，不代表语义审核通过。OCF 减管理层净资本开支仍明确标为算术测算，逐项调节未经核实，不能等同管理层公布的 FCF 或证明没有重复扣减。

失败区分 `editorial_quality_failed`、`reader_structure_failed`、provider HTTP 和流式错误；保留原发布报告不能计作新报告成功。真实发行人测试仍必须检查版本变化、生成时间、reader 全文和审核状态，而非只检查 Workflow complete。
