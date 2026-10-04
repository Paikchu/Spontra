# 前瞻指引提取

从财报新闻稿、股东信、投资者 deck 与电话会转录中提取管理层前瞻指引（季度/年度区间、定性方向、长期目标），确定性核验后发布，并叠加到业务地图的季度收入图上。

## 流程

每个 8-K Item 2.02 业绩发布对应一个 `GuidanceWorkflow` 实例（`workers/pipeline/src/guidance/`）：

1. **事件**：`*/10` Cron 的 `runGuidanceSweep` 只读取已缓存的 SEC filings feed（不发 SEC 请求），登记 400 天内的业绩 8-K 到 `earnings_events`，每次最多启动 2 个实例（新的优先）。实例 id 含 accession 与提取器版本，同一事件同一版本只处理一次。
2. **材料**：读取同 accession 的 EX-99.x（`<TYPE>` 为准）；二进制附件（uuencode PDF/PPT）记为 `unsupported`，不当文本解析。FMP 转录先查日期列表（发布日 −1～+3 天），列出后再取全文。SEC 无 deck 且已知季度时，Tavily 搜一次公司自有域名的 deck，正文必须写明同一财季，否则丢弃；命中的域名记入 `guidance-ir-hosts:v1:{ticker}`，以后限定在这些域名内搜索。
3. **预筛**（`locate.ts`）：只保留前瞻词 + 数字/方向词的段落；Outlook/Guidance 标题下的表格整段保留；safe harbor 等样板剔除；电话会与 deck 带前后各一段上下文。6,000 字符以内的短文档整篇发送。
4. **提取**（`extract.ts`）：每份文档一次 DeepSeek 调用（JSON、`max_tokens` 8192），system prompt 字节固定以命中前缀缓存。
5. **核验**（`shared/analysis-runtime/guidance.ts`）：quote 必须逐字出现在原文（忽略大小写、空白、引号与破折号差异）；每个数值必须出现在 quote 中（支持区间共用量级词、basis points）；单位须与 measure 一致；季度/年度必须有财年。失败项只发一次 repair 调用，仍失败则丢弃。
6. **归并与发布**：同一事件内多份材料重复的同一指引合并引用（新闻稿 > 股东信 > deck > 电话会；数值冲突时保留优先来源）；跨事件按中值、区间宽度判定上调/下调/维持/收窄/放宽；增速指引用上年同期实际收入换算为金额（`derived`）；季度实际收入到达后附上 `actual`。财年→日期由同公司任一 10-Q/10-K 的 DEI 财期锚定推算。结果写入 `sec_cache` 的 `guidance:v1:{ticker}`。
7. **等待电话会**：新闻稿先发布；转录未出现时在电话会后 3/12/36/72 小时各查一次（`step.sleep`，休眠不计费），之后标记 `unavailable`。

## 存储

迁移 `0015_earnings_guidance.sql`（只新增表）：

| 表 | 用途 |
|---|---|
| `earnings_events` | 业绩事件与处理状态、转录状态 |
| `earnings_materials` | 材料清单；id = 规范化正文 SHA-256，正文在 R2 `earnings-materials/v1/{ticker}/{id}.txt` |
| `guidance_extractions` | 模型调用缓存：(材料, 提取器版本) 只调用一次 |
| `guidance_items` | 已核验条目原样（发布时再归并） |
| `ai_usage_log` | 按日/功能/模型累计调用次数与 token（含缓存命中 token） |
| `feature_budget` | 每日硬上限（`guidance-model`、`guidance-search`） |

转录全文只存私有 R2；公开 API 只返回 ≤200 字符的 quote 与来源。FMP 引用链接不含 key。

## 用量控制

- 来源按成本排序：SEC（免费）→ FMP（订阅、零搜索）→ Tavily 仅作 deck 兜底，每日 ≤6 次，搜索与正文均走 `web_search_cache`。
- 内容哈希去重 + 提取缓存：重跑、重试、重复发现都不会再次调用模型。
- 预筛压缩输入；一文档一调用；确定性核验替代模型复核；repair 最多一次且只带失败条目。
- 每日模型调用上限 `GUIDANCE_DAILY_MODEL_CALLS`（默认 40），用尽后实例休眠到次日 UTC 继续。
- 只处理 `SEC_AI_TICKERS`。

## 启用

1. 在 Cloudflare 为 Pipeline Worker（`spontra-analysis`）设置 Secret `FMP_API_KEY`（可选；未设置时只处理 SEC 材料，覆盖信息标记转录不可用）。
2. 推送 main 由 CI 应用迁移 0015 并发布。
3. 用 ORCL/ADSK/NET 近几个季度人工核对提取结果后，将 `GUIDANCE_ENABLED` 改为 `"true"`。默认 `"false"`，不产生任何调用。
4. `GUIDANCE_DECK_SEARCH="false"` 可关闭 deck 搜索兜底。

## 读取

`GET /api/v1/companies/{ticker}/guidance`（scope `analysis:read`）→ 主应用代理 `/api/analysis/v1/companies/{ticker}/guidance` → 业务地图 Worker 二次校验后并入 `/api/business/v1/companies/{ticker}` 的 `guidance` 字段（失败为 null，不影响流向图）。读取从不触发提取。

业务地图趋势图：已报告季度显示该季最后一次收入指引的区间（I 形标记，虚线表示由增速换算）；下一季度新增虚线指引列；选中分部时按成员 id 匹配分部指引；年度与长期指引列在图下一行（只取最近一次发布）。

## 未覆盖

- PDF 附件不在 Worker 内解析；SEC 附件中的 PDF deck 记为 unsupported，IR deck 依赖 Tavily extract 的文本。
- 仅支持美元金额指引。
- 结构化指引尚未回流到 SEC 报告的 synthesis 输入。

## 验证

```sh
node --experimental-strip-types --test tests/pipeline/guidance-runtime.test.ts tests/pipeline/guidance-sources.test.ts tests/pipeline/guidance-workflow.test.ts
npm run typecheck:pipeline && npm run check:pipeline:boundary && npm run worker:pipeline:check
npm run business-site:test
```

测试使用真实 SQLite 迁移、内存 R2、伪造的 SEC/FMP/Tavily 响应与模型，不消耗配额。
