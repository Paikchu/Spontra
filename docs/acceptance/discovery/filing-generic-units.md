# 财报通用计算：单位与冻结来源

本节点修复通用 `compute` 只算数字、任意贴输出单位，以及恢复状态的 fact 缓存值与冻结材料单位混用的问题。只影响新的 producer 状态和采用的计算校验，不改父／子 checkpoint、旧公开正文或预算，不调用模型或生产服务。

## 工具契约

输入仍为 `{label, formula, unit}`。公式引用已读取的 fact 或计算 ID；金额、股数和比例先按冻结材料中的 value、unit 归一，再执行维度运算。数字常数没有货币单位，标签、描述与 assumption 不能补单位。不同币种、金额与股数相加、未知单位均拒绝。输出单位显式选择，例如：

| 公式中的原始事实 | 输出单位 | 输出数值 |
| --- | --- | --- |
| `3661 USDmillions × 0.24 ratio` | `USD` | `878640000` |
| 同上 | `USDmillions` | `878.64` |
| `600 sharesmillion` | `shares` | `600000000` |
| `(3661 − 2144) / 2144` | `percent` | 约 `70.7556` |

最后一项允许在公式最外层显式 `×100` 的常见百分数写法，前提是该节点为已带类型的比例，或相同维度的除法，且输出单位是 percent。不把任意 `42×100`、金额乘 100 或中间节点乘 100 猜成展示换算。

返回值为完整计算对象，含 `id/label/formula/inputs/value/unit/provenance`。`provenance.unitContract` 为 `generic-compute-units.v1`，保留原始输入 value/unit、fact 的精确 material identity、归一后的有效输入、实际公式、百分数展示约定和输出基础单位。新记录的 `inputs` 使用基础单位。衍生输入递归保留计算依赖。

## 历史复用与边界

已保存计算只有在原公式、输入数值、输出数值与单位全部通过冻结材料重放时，才在新 producer clone 中补 `legacy_reverified` receipt；不改旧数字、公式或标签。错百万倍的旧结果、缺来源、循环依赖、篡改 receipt 都拒绝。修正应追加新 cN，并更新正文、图表、投资链及后继计算引用；无原位覆盖接口。未采用的旧计算保留为历史，不阻止有效新结果。

正文绑定、投资链和实际采用图表的依赖参与发布前检查。明确的展示金额与单位也须匹配，不能将 `1 USD` 显示成 `$1m`，或把 USD 结果显示成 EUR。专用 impact 的事实输入同时读取冻结 value **和** unit，不使用 JSON 恢复缓存中的另一个数值。相同 fact ID 来自不同材料或不同元数据时拒绝选择，不采用最后写入者。

recipe 在恢复时仅预载 checkpoint 已固定的历史材料 index，用于确定性重放；无需模型重读整份材料。旧已发布且没有该 contract 的 recheck 保持原行为；有 contract 的新结果须完整重放，篡改视为不可读。

单位 receipt 只证明算术与输入量纲一致，不能证明财务期间、同客户身份、费用符号、经济含义、源数据近似精度或情景合理；独立语义审阅仍须执行。更不能据此把历史窗口的利率敏感度年化成未来净利息。

## 实际验证

执行：

```sh
node --experimental-strip-types --no-warnings scripts/filing-generic-unit-acceptance.mjs
node --experimental-strip-types --no-warnings scripts/filing-generic-unit-acceptance.mjs docs/acceptance/discovery/results/filing-generic-pinned-units.json /tmp/spontra-crwv-real-shadow
```

第二条依赖已保存的本地 CRWV checkpoint、Q3 index 与 Q2 RPO 原始事实投影，没有生产读取。证据：[54 项合成工具旅程](results/filing-generic-units.json)、[58 项含既有 CRWV 材料的旅程](results/filing-generic-pinned-units.json)。使用实际 filing tools、chain/chart、finish、完整语义请求构建，以及真实本地 Miniflare D1/R2 的 recheck 和恢复路径。

- JSON 恢复后，缓存 `16400 USD` 无法冒充冻结 `3661 USDmillions` 得到 82m；同一工具正确接受冻结数值的 3.661bn 输入，并保留缓存原样。
- 实际保存的 CRWV c1/c2 只用比例乘裸常数 3661，无法建立 USD 维度，均拒绝；Q3 已有基础美元事实乘客户比例分别得到 `878640000/1098300000 USD`。
- 固定 Q3/Q2 RPO typed facts 相减得到 `28600000000 USD`；原本地 checkpoint 字节不变。
- 正确旧计算可不经模型重读而补凭据；错 scale 的 legacy、坏计算作为新输入、正文／投资链／图表引用及 receipt 篡改被拒绝。旧无 contract 公开 recheck 行为保留。

本节点没有真实模型语义结论、生产生成、浏览器验收、发布或人工财务签核；这些不由合成结果替代。
