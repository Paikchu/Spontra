# 公司研究关系复用已验证业务 tag

基线：`38e97415`，2026-11-17 UTC。本节点遵循 [AGENTS.md](../../../AGENTS.md)，只修改代码并运行本地操作旅程；未创建业务 tag、运行真实模型、改写生产数据或 CRWV 正在运行的子任务。仓库未发现 `.agents/skills`，延用 Cloudflare Workers / Wrangler 指导。

## 单一来源与兼容方式

已有 `sec_business_tags` 继续负责业务分类、verified/rejected 状态及冻结财报来源。新增 [tag adapter](../../../workers/analysis/src/public-research/tag-exposure.ts) 只读取现有 tag，复用 `readMaterialSnapshot` 与 `sourceText`；核对公司、material identity、完整段落/CSV 的 SHA-256、实际引用摘录和来源时点，不触发材料准备、模型分类或 peer 匹配。

公司研究关系仍存在同一 `company_research_exposures` 表；报告 `industryId` 是报告关联标识，与业务 tag 的 sector/facet 分开。可选 `tagBinding` 记录 tagId、语义 fingerprint、算法版本、精确 baseVersion 及所有 source refs/摘录哈希。原文和分类以 tag 为准，`businessTag` 是读取时派生的投影，不建立第二套分类表。财务 weight、weightBasis 等独立保留，未知继续为 `null`。

新增认证管理接口：

```http
POST /api/admin/public-research/exposures/from-tag
Content-Type: application/json

{"exposureId":"existing-relation-id","baseVersion":"exact-existing-version","tagId":"existing-verified-tag-id"}
```

此接口只接受三个字段；客户端 classification、source、status、weight 等额外字段均拒绝。服务器读取精确 base 并为同一 exposureId 追加不可变版本；不另建关系。版本由 base 与业务含义/tag 语义决定，不依赖当前时间、collectedAt 或展示字段；并发或重放返回同一已保存正文。已变更的 base 或 tag 语义要求明确复核，不能静默重新分类。

fingerprint 包含 ticker、unit、sector、facet、英文 label、definition，以及排序后的精确来源 refs 和实际摘录哈希。labelZh、updatedAt、来源排列、collection metadata 和算法版本号本身不代表业务变化；算法版本仍保留在审计及当前投影中。分类、定义、来源身份或原文内容的变化会要求复核。

[context.ts](../../../workers/analysis/src/public-research/context.ts) 在冻结、采用和结果依赖读取时共用 resolver，并读取既有 `company_research_contexts.mapping_versions`。同一关系的旧手工版本也跟随其 tag 绑定 family 校验；tag 被拒绝、删除、改语义或原文损坏后，旧版本不能凭原有 `status: verified` 绕过。旧 `a4` → tag 绑定的纯来源增强不使业务/权重相同的运行中或已保存结果失效；真正的财务权重、业务关系或适用性变化仍精确标记待复核。没有研究 context 的历史结果继续兼容。

[shadow-context.ts](../../../workers/analysis/src/filing-analysis/shadow-context.ts) 仅接入同一 resolver；在显式新子任务追加行业时，允许同 ID 的纯 tag 来源增强，保留父报告顺序和原 mapping pin。它不回写父 context、state 或 spec；其他 mapping 变更仍被拒绝。

未新增表或 migration。材料读取的两个函数只收窄了其所需的存储类型，公共研究存储声明补充可选 byte-range 能力；材料读取行为没有变化。

## 实际验收

```sh
node scripts/company-tag-exposure-acceptance.mjs docs/acceptance/discovery/results/company-tag-exposure.json
```

[54 项真实本地 Cloudflare 旅程](results/company-tag-exposure.json) 全部通过：管理站 handler → 同源 proxy → 命名 AdminGateway → 认证分析 handler → 真实 D1/R2 → 原文 reader → freeze/adoption/status → shadow continuation。使用一个已有合成 tag、三份原文和同一关系的历史版本，外部请求为零。

- 正向：同 ID 追加、三份来源完整投影、weight=null、并发同一版本、展示/collection/算法审计元数据更新不新增版本、不失效；旧 a4 结果及原运行 pin 可继续采用，父 context 哈希不变。
- 反向：错 base、跨公司 tag/material、缺材料/原文、第二份原文哈希损坏、客户端伪造分类/状态/来源、tag 拒绝/删除/语义变化均拒绝或明确待复核，且阻止采用。历史 asOf 也不能旁路当前 tag 撤销。
- 真实财务权重变化：旧结果待复核，新权重版本仍复用同一个业务 tag；父 shadow continuation 继续拒绝真正的 mapping 变化。

既有公共研究操作旅程 37 项、公司公共研究工具旅程 27 项/36 次操作、shadow resume 旅程 104 项回归通过；后者的模型响应全部是隔离的本地合成 transport，真实付费调用为零。全仓、Analysis、Admin 类型检查和定向 lint 通过，Analysis/Admin dry-run 通过。

本轮全仓 lint 实测为既有 **9 errors / 5 warnings**，改动文件零 finding。相较此前记录 10 errors，`38e97415` 已移除 `FilingReport.tsx` 原 set-state-in-effect finding；本节点未修改该文件，也未扩展 lint 整改。

## 发布边界

本节点没有 commit/push/deploy 或生产 from-tag 调用。生产唯一 CRWV 关系的来源增强须由发布节点在当前子任务结束后，以其精确 baseVersion/tagId 追加版本，并回读新旧结果状态。当前运行子任务及父 context 仍维持原冻结版本，不能把本地合成通过说成生产绑定已完成。
