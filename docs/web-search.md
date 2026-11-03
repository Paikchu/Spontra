# Web Search 模块

入口：`workers/analysis/src/web-search/research-search.ts` 的 `researchSearch(env)`。业务解读、业务脑图、指引、分析师、估值与公司分析的 Agent 都经它检索网页和读网页，结果缓存在 D1 + R2。只需要模型密钥 `DEEPSEEK_API_KEY`；`researchSearchConfigured(env)` 判断是否可用。

## 组成

| 文件 | 职责 |
| --- | --- |
| `claude.ts` | `ClaudeWebProvider`：经 DeepSeek 的 Anthropic 兼容接口调用 Messages API 服务端工具 `web_search` / `web_fetch`，只取证据、不要生成的回答；搜索结果的摘录是模型逐字引用的段落，PDF 在这里抽取文字。每次调用记入 `ai_usage` |
| `page.ts` | `DirectPageProvider`：网页先由 Worker 直接读取（有 Workers AI `toMarkdown` 时转 Markdown），读不到才回退到模型的 `web_fetch`，因此读一页通常不花 token |
| `service.ts` | `WebSearchService`：校验请求、查缓存、占用与发布 |
| `store.ts` | `D1R2SearchStore`：D1 存指针与占用，R2 存结果体 |
| `validation.ts` | 请求规范化、公开 URL 校验、`isEdgarUrl` |

## SEC 原文不经网页模块

搜索结果中的 EDGAR 链接一律剔除（缓存命中也剔除），`fetchContent` 遇到 EDGAR 地址直接报 `archive_only`。SEC 原文只从归档读取，见 [SEC 归档](sec-archive.md)。

## 缓存语义

缓存键包含版本、供应商、scope、操作类型及全部标准化查询条件。`scope` 由可信后端选择；公开资料使用统一 scope。只规范化域名排序/去重和首尾空白，保留查询大小写及内部空白。URL 保留 query 参数、去掉 fragment。

默认搜索 1 小时、读网页 24 小时；空搜索最多 5 分钟。调用方可指定 0 至 30 天的最大缓存年龄，0 表示不复用；`refresh: true` 跳过旧值但仍受并发占用约束。命中须同时满足存储期限与本次 maxAge，不返回过期资料。供应商失败不作为空结果缓存，失败刷新保留原有正文。

D1 原子占用两分钟；竞争方得到可重试的 `busy`，由所在 Workflow 延迟重试。R2 先写 owner 唯一对象，再按 owner 和未过期 lease 更新 D1 指针，旧 owner 无法覆盖后续结果。进程崩溃或网络不确定失败可能造成重复外部请求，不保证 exactly-once。

每次返回 `provider`、`fetchedAt`、`expiresAt`、`cacheKey` 和 `cache: hit|miss`，Agent 可以追溯资料时效。网页正文是不可信证据，模型不执行其中的指令。

迁移：`workers/analysis/migrations/0011_web_search_cache.sql`。
