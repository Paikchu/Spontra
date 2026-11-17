# G5/G8：冻结公共来源进入财报审阅和共享结果

2026-11-17。仅本地代码与合成资料旅程，没有模型、网络、生产操作或报告发布。原始复现代码基线为 `38e97415ff054f5ea1175bcc3e4e4c34d2ea0b41`。

## 已复现问题

实际 `read_public_research` / `record_public_research_use` 成功后，`public1c1` 等来源注册在 composer；完整正文只在公共工具闭包中，未写入 `web` / `periodic.texts`。财报独立审阅却仅从这两处重建非材料来源。

本地五种路径均实际抛出 `JudgeUnavailable`：block.sources、HTML `data-source`、投资链 sourceIds、行业 `public2c1`、JSON 恢复后的 HTML。仅在 metadata 记录采用时不触发。这个复现不能证明当时运行的 CRWV 任务已命中该路径。

## 最小修复

- `context-tools.ts` 提供共享纯函数，从任务 `spec.publicResearch` 的冻结 ordinal / claim 重建原有 JSON，公共工具读取格式保持一致。
- `semantic-audit.ts` 显式接收该冻结快照。实际引用 `publicNcM` 时检查保存的报告 ordinal、reportId、version，以及已登记引用 URL 的版本 / claim；缺失或错配继续拒绝。相同名称的 web / texts 缓存不能覆盖快照。
- `recipe.ts` 仅在独立审阅调用行传入 `spec.publicResearch`。
- `impact-publication.ts` 使用同一函数及绑定检查，保存与独立审阅逐字相同的公共原文、来源和 observations。不会给 sidecar 保存空的公共来源正文。
- 不读取当前 live 公共报告、不修改旧 checkpoint、不删除引用绕过审阅，也不改变 tag、schema、admin 或 proxy。

## 验证

`node --experimental-strip-types --no-warnings scripts/filing-public-source-acceptance.mjs`：**18 项通过**，详见[结果](results/filing-public-source-evidence.json)。

实际旅程包括：工具读取和采用宏观 / 行业 → HTML 和投资链引用 → 完整语义审阅输入 → JSON 状态 / spec 恢复 → 使用完整合成缓存审阅回执的真实 `finish` → `onShadow` / sidecar。两处公共来源字节一致，仍为 `frozen-macro-v1` / `frozen-industry-v1`，原始 URL 与 5 percent observation 保留。

反向包括：缺冻结 context、未知 report / claim ordinal、错 metadata 版本、错引用 URL 版本、重排 ordinal、伪造同名缓存、错 sidecar spec 版本和未知 sidecar 来源。全部明确拒绝，原保存结果不变；没有尝试网络调用或读取 live 公共报告。

既有 typed-unit 旅程 **26 项通过**、投资影响 publication 旅程 **31 项通过**。Analysis 类型检查与修改范围 ESLint 通过，`git diff --check` 通过。缓存 verdict 和 render 边界属于合成 fixture，不能冒充真实内容审阅或 G10 生产通过。

本节点没有提交、部署、修改当前真实 CRWV 任务或批准报告。最终合并检查、上线与真实报告读回由主任务执行。
