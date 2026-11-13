# 网页检索与证据读取

Spontra Analysis 的网页搜索不再运行独立的中间模型，也不再有 `web` 模型配置。

## 主 Agent 工具循环

估值研究、分析师、业务脑图、公司分析，以及使用共享 compose 工具的文件分析、财务体检和研究报告，直接向 DeepSeek Messages API 提供原生 `web_search_20250305` 工具。

- 主 Agent 在思考中选择查询；服务端执行搜索并继续同一次模型回复。
- 完整 assistant 内容（thinking、server_tool_use、web_search_tool_result、引用）保留在后续请求中。
- `web-search/native.ts` 读取服务端结果。Harness 在本地为有效结果登记来源编号，并把编号作为下一条 user 消息的文本交给 Agent，不伪造客户端工具调用或工具结果。
- 原生搜索每轮最多一次；用完该流程的总搜索预算后，不再提供工具。搜索失败也占用一次预算。
- 搜索结果只是线索。原有网页读取工具继续读取正文、保存可核验的摘录和来源，然后生成证据 ID。估值与分析中的引用校验继续使用这些登记的证据。
- 归档文件工具保持不变。所有搜索工具排除 SEC 域名；返回结果仍经过 SEC 地址过滤。SEC 原文只能通过 `sec-archive` 和文件库读取。
- 历史快照估值、研究收尾等不允许联网的阶段，不提供原生搜索工具。

共享循环在 `agent-loop.ts` 中处理搜索登记；业务脑图和分析师自己的循环遵循相同协议。公司分析已从 JSON action 调度改为连续工具消息，保留思考上下文。

## 程序检索与网页读取

业务解读的预先资料收集等固定程序检索，通过 `DeepSeekWebProvider` 直接访问 `POST /v1/tools/search`。这是不带 model 或 messages 的原始 API，不启动搜索代理。查询遵守该接口的 128 字符限制，返回结果仍按域名和日期过滤。

网页正文优先由 Worker 直接下载并转换；不能直接读取时，调用 `POST /v1/tools/fetch`，不调用模型的 `web_fetch`。SEC 地址和跳转到 SEC 的请求继续拒绝。

这些程序检索和页面读取沿用 `WebSearchService`、D1/R2 缓存与并发租约。原生搜索发生在主模型请求内部，不经过独立的搜索缓存；其消息随 Workflow 的模型步骤持久化，已读取网页的证据保存流程不变。

## 用量与后台设置

- 原生搜索的 `usage.server_tool_use.web_search_requests` 计入主 Agent 那条 `ai_usage` 记录，保留公司、模型、阶段和运行 ID。
- 原始 Search/Fetch 请求单独记录接口用量，标记 `search-fetch-api`，不虚构模型 token。
- `AI_TOOLS` 已移除 `web`。后台列表不再显示该配置，更新旧配置的请求返回 404；数据库里已有的旧 `web` 设置不再参与模型解析。无须数据库迁移。

官方接口：[思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)、[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)、[Search/Fetch](https://api-docs.deepseek.com/zh-cn/guides/search/)。
