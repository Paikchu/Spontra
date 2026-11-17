# 固定材料 range 缓存：本地验收

2026-11-17 05:24 UTC，本地真实旅程 exit 0，54/54 项通过。结果为 [filing-reviewer-correction-material-cache.json](results/filing-reviewer-correction-material-cache.json)，由 [filing-operator-completion-acceptance.mjs](../../../scripts/filing-operator-completion-acceptance.mjs) 生成；已发布的 47 项异步验收 JSON 保持原字节和 SHA `df0b61425c187300a73e2fcb43e25fe2e632921b3b716f160248de39a38513fe`。

```bash
SPONTRA_ASYNC_PROOF_ONLY=1 SPONTRA_MATERIAL_RANGE_CACHE_ACCEPTANCE=1 \
  node scripts/filing-operator-completion-acceptance.mjs
```

本轮只验证局部固定材料读取缓存和相关异步门槛，未重复完整 171 项。64 次模型 HTTP 全部为合成传输，真实模型调用、生产访问和部署均为 0。

原 47 项真实 proxy → AdminGateway → TaskRunner 旅程通过：坏用量、peer HTML 与来源输入变化在认领后 durable `failed/new0/inherited7`，公开 v6/hash 保持；真实 R2 get 返回持有 31,501ms 时，proxy 202 为 55ms，精确重放 21ms 且只派发一次；继承额度 12、cold restart、expired lease 和 stop 的迟到围栏均保持。

新增 7 项为实际材料读取旅程，没有直接种入成功回执：从本地真实失败 shadow 的保存状态打开生产 `filingOperatorHarness`，通过 `contentInput` 的实际证据搜索触发 Markdown range 读取。报告仅在隔离内存副本中设为读取探针，不发布或写回研究状态。

| 检查 | 实际结果 |
| --- | --- |
| 同一 harness 第一次/第二次 `contentInput` | 实际 range get 为 1 / 0 |
| 新 harness | 再次 range get 1；index 也重新读取 |
| 实际 provider body 与完整输入/块哈希 | 两次缓存调用与 fresh harness 三者相同 |
| 不同 prepared ref 共用同一不可变对象 | 各读一次，共 2 次 range get，文本一致 |
| 对象缺失后补齐重读 | 首次实际 `MATERIAL_MARKDOWN_MISSING`；补齐后成功，共 2 次 range get |
| R2 对象 body 消费 | 每个 range 对象最多消费一次；没有重复使用已消费的 R2 body |
| 研究和模型调用 | 原保存 ledger 字节不变；新增模型 HTTP 为 0 |

三次输入哈希均为 `e8fb4b57731ecdaac61927af6eca6b48b6067ebfc729e3cd77a7bdcc83a45a6d`，块哈希均为 `67b9e8b13db571c3808f4a488574f5fb365471726a307c4c79c3e810dda59e08`。结果 JSON 保存实际 key、offset、length 和 body 消费计数。

缓存只在单次 operator harness 的固定材料范围内复用已校验长度的字节，不缓存数据库、当前依赖、R2 对象或失败结果。本旅程使用合成材料验证隔离与边界，不替代真实 CRWV 完整输入的独立 before/after 哈希审查，也不证明真实模型结论质量。
