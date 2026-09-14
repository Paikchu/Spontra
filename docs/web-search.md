# Web Search 模块

服务端入口：`workers/pipeline/src/web-search/index.ts`。这是供财报 Pipeline 后续调用的 TypeScript 模块，本次不增加浏览器可调用的付费搜索 HTTP API，也不自动改变 SEC 分析流程。

## 接入

```ts
import { createTavilyWebSearch, WebSearchError } from "./web-search/index.ts";

// 在 Worker/Workflow 内创建；不要在模块全局保存请求相关对象。
// TAVILY_API_KEY 是后续接入时需声明/配置的服务端 Secret，不能放进前端环境变量。
const search = createTavilyWebSearch(env.DB, env.SEC_FILINGS, env.TAVILY_API_KEY);
const policy = { scope: "public:research-v1", maxAgeMs: 60 * 60_000 };

try {
  const found = await search.search({
    query: 'Microsoft FY2026 Q4 earnings call transcript',
    maxResults: 5,
    depth: "basic",
    includeDomains: ["microsoft.com"],
  }, policy);
  // 由调用方选取相关来源，不自动抓取所有搜索结果。
  const hit = found.data.results[0];
  if (hit) {
    const source = await search.fetchContent({ url: hit.url }, {
      ...policy, maxAgeMs: 24 * 60 * 60_000,
    });
    // source.data.text 是原始提取文本；completeness 始终为 unverified。
    // 后续财报功能先验证公司/财年/季度/会议日期/Q&A/截断，再作为 transcript 使用。
  }
} catch (error) {
  if (error instanceof WebSearchError && error.code === "busy") {
    // 同一条件已有检索进行中。通过现有 Workflow 的延迟重试重新调用，或返回处理中。
    // 不在一个请求内无限轮询，也不要绕过缓存再调用供应商。
  } else {
    throw error;
  }
}
```

`scope` 必须由可信后端选择。允许共享的公开资料使用统一 scope；私有或账号授权内容使用 tenant/权限范围。不能直接采用未经授权检查的用户输入。缓存键包含 scope 的 SHA-256，不存明文查询到 D1。

## 扩展接口

- `SearchProvider`：实现 `id`、`search()`、`fetchContent()` 即可接入其他供应商。`id` 包含适配器版本；变更响应解析和隐式选项时升级版本。
- `createWebSearch({ database, bucket, provider })`：供应商可替换，复用 D1/R2 存储。
- `SearchStore`：可替换存储层；`claim` 必须原子实现，`publish` 必须按 owner 和未过期 lease 条件提交。
- `search`：支持结果数、搜索深度、新闻/通用、域名和日期范围。
- `fetchContent`：按 URL 获取 Markdown；不推断公司、季度、语言或完整性。
- 每次返回 `provider`、`fetchedAt`、`expiresAt`、`cacheKey` 和 `cache: hit|miss`，Agent 可以追溯资料时效。

请求参数运行时校验；每次搜索最多 20 条结果；Tavily 请求固定 HTTPS endpoint、30 秒超时、4 MiB 响应上限，禁止自动增加搜索深度和生成答案。无内部自动重试，避免隐藏计费；调用方应对 retryable 错误设置有限重试和任务费用预算。

## 缓存语义

缓存键包含版本、供应商、权限范围、操作类型及全部标准化查询条件。只规范化域名排序/去重和首尾空白，保留查询大小写及内部空白；不做可能改变语义的模糊合并。URL 保留 query 参数、去掉 fragment。

默认搜索 1 小时、提取正文 24 小时；空搜索最多 5 分钟。调用方可指定 0 至 30 天的最大缓存年龄，0 表示不复用；`refresh: true` 跳过旧值但仍受并发占用约束。缓存命中同时满足存储期限与当前调用方 maxAge，绝不静默返回过期资料。API 失败不作为空结果缓存，失败刷新保留原有正文。

D1 原子占用两分钟；竞争方返回 `busy`，后续重试读取已完成结果。超时可重新占用；R2 先写 owner 唯一对象，再检查当前时间、owner 和 lease 更新 D1 指针，旧 owner 无法覆盖后续结果。进程崩溃、网络不确定失败可能造成重复外部请求，不保证 exactly-once。自定义供应商也应设请求超时，低于 lease 时长。

R2 对象不直接公开；旧版本或失败发布产生的孤立对象目前保留。后续清理应保留 D1 正在引用的对象并设置宽限期，不能单纯按整个前缀的固定 TTL 删除，否则会破坏长缓存。本版缓存体由服务端写入并信任，不接受客户端写缓存内容。

## Transcript 的后续扩展边界

本版提供精确搜索缓存和 URL 正文缓存，不声称不同自然语言查询会命中同一会议。后续 `getTranscript(companyId, fiscalYear, fiscalQuarter, meetingType, language)` 应先查公司会议资料索引，核验 requireQA 等要求，再在缺失时调用本模块；可复用本模块的 provider/store 接口，但完整资料索引应与短期搜索缓存分开。

模型必须将网页正文视为不可信证据，不能执行其中的指令。公开可访问不等于允许跨用户缓存或全文再分发，scope 的共享策略需符合供应商及原始来源授权。

## 数据库与启用

新增分析数据库迁移 `workers/pipeline/migrations/0011_web_search_cache.sql`，Drizzle schema、snapshot、journal 同步。仅新增一张表，无已有数据变更。使用现有 `DB` 和 `SEC_FILINGS`，不需要新 Worker、Queue、KV 或 Durable Object。

Pipeline 的自动发布脚本现已按“应用分析数据库迁移 → 核对迁移 → 发布 Worker”执行。`worker:pipeline:migrate:ci` 与发布脚本仅供 main 触发的 Cloudflare CI 执行，不在本地手动运行。线上在财报 Pipeline 配置 TAVILY_API_KEY Secret；没有调用方引用这个模块时不发起搜索请求。

本地验证：

```sh
node --experimental-strip-types --test tests/pipeline/web-search.test.ts
npm run typecheck:pipeline
npm run check:pipeline:boundary
```

测试使用真实 SQLite 执行迁移及条件 SQL、内存 R2 和合成供应商响应，不消耗 API 配额。真实搜索覆盖率与 transcript 完整性需另用关注公司样本评估。

官方接口参考：
- https://docs.tavily.com/documentation/api-reference/endpoint/search
- https://docs.tavily.com/documentation/api-reference/endpoint/extract
- https://developers.cloudflare.com/workers/best-practices/workers-best-practices/
