# Spontra 架构图

这三张图按仓库 `fc31d72bf6a7568a32f25fecee6debc833c00ece` 的代码、`wrangler.jsonc` 和 D1 migration 画出。节点和连线都对应真实入口、绑定或外部调用。用浏览器打开同目录的 HTML 即可交互查看；PNG 与 SVG 是 Archify 查看器导出的静态图。

## 系统架构

`spontra-system.html` 画的是三个 Worker 怎么拼在一起。

- 读者打开 `spontra-business-map`。公开页走 `MapReads` 只读 D1；`/agents/*` 交给 `StageGateway`，每个会话一个 `StageAgent`。公司标志只从 `images.financialmodelingprep.com` 拉图片，不是行情接口。
- 运营人员打开 `spontra-admin`。配置了 `ACCESS_TEAM_DOMAIN` 和 `ACCESS_AUD` 时校验 Cloudflare Access JWT；分析请求经 `AdminGateway` 用 `REPORT_ADMIN_PASSWORD` 换会话。管理端的分析数据是去业务站读 telemetry。
- `spontra-analysis` 才持有 D1、R2、Vectorize、Workers AI、Browser Rendering、两条队列和死信队列。Cron 每 10 分钟跑一次。模型任务进 `TaskRunner`：对话走 DeepSeek，可选的评审走 OpenAI，向量走 Workers AI 再写入 Vectorize。

仓库里没有 KV 绑定，也没有 iOS 客户端。

## 主链路

`spontra-filing-pipeline.html` 按数据方向画发现、入库、分析、发布、对外读取。

Cron 读 SEC EDGAR submissions、每天最多一次 Nasdaq Trader 符号文件，并刷新 Yahoo 收盘。新 filing 先写入 D1 的 `pipeline_outbox`，再刷到 `spontra-pipeline-events`。事件消费者登记到期任务，`spontra-pipeline-tasks` 每次处理一条。原文快照放在 R2 `sec-materials/v1/`。需要模型的步骤由 `TaskRunner` 调 DeepSeek；Alpha Vantage 的电话会纪要和 OpenAI 评审都是可选的。发布结果留在 D1，公开站只通过 `MapReads` 读出来。

## 表关系

`spontra-d1-erd.html` 只画 migration 里真正声明了 `FOREIGN KEY` 的 9 张表：Yahoo fundamentals 三张，valuation 四张，public research 两张。重放 `workers/analysis/migrations` 后库里一共 84 张表，其余 75 张用 ticker、accession 等字段关联，SQL 里没有 `REFERENCES`，所以没有画成外键。虚线表示非标识关系；`valuation_current.version_id` 可空。

## 图里仍然交叉的线

自动检查已经通过。系统图里仍有若干线在节点之间交叉，一次只改位置的重排没有通过校验，因此保留当前布局。数据流图里 cron 到 D1 的行情线会绕开中间节点。这些是走线，不是多出来的组件。
