# G8：财报投资桥的通用计算依赖

本节点只修复不可变投资桥 sidecar 漏存通用计算的中间结果与原始来源。未调用模型、生成生产报告、写生产、提交或部署；没有修改单位 helper、periodic 工具、recipe 或 operator 实现。

## 复现与根因

`filingSemanticInput` 已递归 `periodic.computed[id].inputs`；原 `saveFilingImpact` 的 refs visitor 只递归专用 impact 的 `provenance.inputs`。投资链只直接引用 `c3`，其实际依赖为 `c3 → c2 → c1 → f…` 时，真实 producer 的审核与 `finish` 可以通过，但 sidecar 的 `arithmetic` 只有 `c3`。中间计算和原 fact 因而无法从这份不可变结果完整还原，详细页也缺原始来源。

使用实际 local `filingLoader → read/compute → record_investment_impact → finish → onShadow → readFilingImpact` 旅程复现。为避免回退共享工作区，用本地 Node loader 仅把 visitor 替换为原实现，断言明确得到 `expected: [c1,c2,c3], actual: [c3]`。该复现采用完整合成语义 pass 缓存和渲染边界 fixture，不代表真实模型或人工财务审阅。

## 修改

在 `workers/analysis/src/filing-analysis/impact-publication.ts` 的同一 refs visitor 加入 `Object.keys(p.computed[ref]?.inputs ?? {})`，与专用 impact 的输入共同递归。仍从本次投资链实际采用的引用出发，不导出整个历史计算集合，不改动原始 work 或已发布 sidecar。

## 实际验证

命令：`node --experimental-strip-types --no-warnings scripts/filing-impact-dependencies-acceptance.mjs`。

结果：[15 项旅程证据](results/filing-impact-dependencies.json)。包括：

- `3661 USDmillions → c1: 878.64 USDmillions → c2: 439320000 USD → c3: 219660000 USD`，经过 JSON 恢复、完整语义请求及真实 `finish` 后，三层计算与原 fact 的 value、unit、period、URL 均写入 sidecar。
- 原始披露单位与基础单位的 generic provenance 未丢失，精确 work 再次保存的 resultId 与 inputFingerprint 一致。
- 缺失中间结果、篡改中间 value、循环计算依赖均被真实 `finish` 拒绝，没有生成 validated shadow。
- 不可达的旧无单位契约 impact、弃用的 generic 结果及其独有 facts 不导出，历史 work 仍保留这些记录。
- 无匹配估值模型时 eventChange、referenceQuote、modelVersion 仍为 null。

单位 helper／periodic 复用契约另做只读复核：通用计算按冻结 index 的 value、unit 与 material 重放，不靠标签或 assumption 补单位，正确旧结果仅补确定性 receipt。复核当时还发现专用 impact 的 `sourceValues` 可能混用缓存 fact.value 与冻结 index.unit：本地负向探针把缓存 3661 改成 16400 后可获得 82m 结果。这不是生产报告已出错的证据。后续已由单位节点修复为同时使用冻结 value/unit；同一探针重跑 accepted=false，54项合成及58项固定原材旅程通过，见[单位节点](filing-generic-units.md)。本依赖递归节点没有跨范围修改该实现。

本节点未验真实报告、人审、浏览器呈现或生产发布；这些不能用本地合成结果替代。
