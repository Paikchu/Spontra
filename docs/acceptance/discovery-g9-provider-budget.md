# G9 公共研究模型调用预算

状态：本地实际 SDK / Harness + 模拟 HTTP 供应商旅程通过；生产付费调用未执行。

## 发现与修复

在安装的 `@earendil-works/pi-durable` 1.5.0 中，`scheduler.js` 的 `hooks.each` 会捕获扩展 hook 抛出的异常。因此 `beforeRequest` 或 `beforeProviderRequest` 抛错不能作为阻断付费调用的边界。现有 host 的 `guard` 也会捕获错误。另一个边界是 provider 内部重试：不能假定每次 HTTP 重发都会先经过生成 hook。

公共研究显式设置 `PiLoaded.strictBudget: true`。其调用配额在实际 HTTP transport 发出请求前原子预留，包含供应商内部重试和上下文压缩调用。通过导出的 `ProviderDoc` 绑定持久化 session 身份，避免并发研究串用额度。数据库的 `state='running'` 与 `calls_reserved < max_calls` 条件共同阻断停用或超额请求。拒绝及数据库错误不会到达供应商 transport。

旧业务没有设置该选项，继续使用原有的预留 / 退款行为。公共研究不在启动和工具轮结束时提前扣调用额度，也不退还已发出请求的额度；供应商报错仍可能计费，因此采用保守记账。已经预留并在途的请求不是新增请求，停止操作不能撤销供应商已经接收的工作。

## 实测

执行：

```bash
node --experimental-strip-types scripts/public-research-budget-acceptance.mjs
```

该脚本使用安装的真实 Pi SDK、Harness、MemoryStorage、SQLite 原子条件更新与仅监听 `127.0.0.1` 的模拟供应商。没有生产凭证，没有付费请求。

| 场景 | 实际到达模拟供应商的 HTTP 请求 |
| --- | --- |
| 配额为零 | 0 |
| 配额 1，供应商返回 500 并配置重试 | 1 |
| 10 个并发会话共享配额 1 | 1 |
| 任务状态 stopped | 0 |
| 新建 registry 模拟恢复，继续读取已耗尽额度 | 合计 1 |
| 未启用 strictBudget 的旧流程 | 1，未被新门禁改变 |
| 实际 Harness 捕获 advisory hook 错误后再发下一轮 | 合计 1；第二轮被 transport 阻断 |
| 实际 compact() 走上下文总结模型路径 | 合计仍为 1；压缩也被耗尽额度阻断 |

analysis:typecheck 通过，新增 transport helper 和旅程脚本的定向 ESLint 通过。

## 明确限制

`max_calls` 是模型 HTTP 调用次数硬限制，不是金额上限。`maxTokens` / recipe token budget 仍是基于已报告用量的停止阈值，不能保证正在处理的请求或上下文压缩的输入 / 输出 token 不越过该值。没有精确输入 token 预估与供应商结算上界，不能称其为硬 token 或美元预算。

搜索、网页读取等工具仍有各自的次数限制及使用记录，不属于模型 `max_calls`。本旅程证明模型请求的阻断边界，不证明外部工具具有统一货币预算，也不替代整个 G9 的依赖传播、死信恢复和生产验收。
