# Spontra lint只读溯源审计

当前 `0a45a4238df15f6d6bc9d8c766cd0614a1d10d7b`；基线 `b1d73fcfbb11eaa829d2d4ea97f449cff98c4cf6`。

**结论：当前实际重跑10 errors / 5 warnings；需求开始基线实际重跑11 errors / 5 warnings。当前15条全部在基线存在，无本轮新增lint问题。文件有改动不等于报错行由本轮新增。**

执行：当前 `npx eslint . --ignore-pattern dist --format json --output-file /tmp/spontra-lint-current.json`；基线以git archive导出/tmp独立目录，软链接同一node_modules后执行同规则全仓ESLint。两次退出1均因lint问题；eslint.config.mjs与package-lock.json在基线至HEAD没有变化。未修改仓库、未提交、未触发模型或生产任务。

## 数量变化

- 11→10 errors：原ValuationPanel.tsx:544的preserve-manual-memoization问题随估值展示改造消失。旧useMemo依赖storedReport?.model而回调访问storedReport；新实现保留报告基准模型而不随最新股价改写，已删除这处memo。不是关闭规则。
- 3→5 warnings：较此前清理提交c984385，ec808214（2026-11-15）添加两个SEC material验收Worker，匿名default export各产生1条warning；它们在b1d73fcf前已存在。此前3条仍为core.now、operations.workflowInstanceId、SEC_CANONICAL_SERIES_IDS。没有重跑c984385全仓，3条历史数量依既有记录；新增两条的文件引入提交与当前/基线结果已核实。

## 逐项

|位置（固定提交链接）|规则/级别|优先级与判断|来源|
|---|---|---|---|
|[apps/admin/src/ai-runs.tsx:91:5](https://github.com/Paikchu/Spontra/blob/0a45a4238df15f6d6bc9d8c766cd0614a1d10d7b/apps/admin/src/ai-runs.tsx#L91)|`react-hooks/set-state-in-effect` error|P2 响应列表变化时同步setTicker校正当前选择；额外渲染，通常同值会跳过，不是已证实无限循环。|`2c5d3885`；基线行91；文件未改|
|[apps/admin/src/translations.tsx:34:36](https://github.com/Paikchu/Spontra/blob/0a45a4238df15f6d6bc9d8c766cd0614a1d10d7b/apps/admin/src/translations.tsx#L34)|`react-hooks/set-state-in-effect` error|P2 effect清理queued或随ticker清理queued/triggerError；意图合理但多一轮渲染，切公司时瞬态旧状态可见。不是确认的数据损坏。|`dff37af0`；基线行34；文件未改|
|[apps/admin/src/translations.tsx:35:47](https://github.com/Paikchu/Spontra/blob/0a45a4238df15f6d6bc9d8c766cd0614a1d10d7b/apps/admin/src/translations.tsx#L35)|`react-hooks/set-state-in-effect` error|P2 effect清理queued或随ticker清理queued/triggerError；意图合理但多一轮渲染，切公司时瞬态旧状态可见。不是确认的数据损坏。|`dff37af0`；基线行35；文件未改|
|[apps/business-site/src/ArtifactPreviewPage.tsx:42:19](https://github.com/Paikchu/Spontra/blob/0a45a4238df15f6d6bc9d8c766cd0614a1d10d7b/apps/business-site/src/ArtifactPreviewPage.tsx#L42)|`react-hooks/set-state-in-effect` error|P2 缺token分支effect内同步setState；一次额外渲染，宜从输入派生缺token状态。|`2c5d3885`；基线行42；文件未改|
|[apps/business-site/src/FilingReport.tsx:57:5](https://github.com/Paikchu/Spontra/blob/0a45a4238df15f6d6bc9d8c766cd0614a1d10d7b/apps/business-site/src/FilingReport.tsx#L57)|`react-hooks/set-state-in-effect` error|P2 请求变化时effect同步清failed；产生额外渲染。该lint不证明旧报告短暂保留问题；请求取消已有AbortController。|`dff37af0`；基线行50；文件本轮改过，报错行未变|
|[apps/business-site/src/stage/StageHost.tsx:76:5](https://github.com/Paikchu/Spontra/blob/0a45a4238df15f6d6bc9d8c766cd0614a1d10d7b/apps/business-site/src/stage/StageHost.tsx#L76)|`react-hooks/set-state-in-effect` error|P2 禁用stage时effect同步重置多个state；批处理仍需额外提交，可能短暂保留旧stage视觉。没有循环证据。|`0773d42c`；基线行76；文件未改|
|[workers/analysis/scripts/sec-material-acceptance-proxy.ts:3:1](https://github.com/Paikchu/Spontra/blob/0a45a4238df15f6d6bc9d8c766cd0614a1d10d7b/workers/analysis/scripts/sec-material-acceptance-proxy.ts#L3)|`import/no-anonymous-default-export` warning|P3 验收Worker匿名默认导出对象；合法模块，无功能故障，命名仅利于调试/风格。|`ec808214`；基线行3；文件未改|
|[workers/analysis/scripts/sec-material-acceptance-worker.ts:20:1](https://github.com/Paikchu/Spontra/blob/0a45a4238df15f6d6bc9d8c766cd0614a1d10d7b/workers/analysis/scripts/sec-material-acceptance-worker.ts#L20)|`import/no-anonymous-default-export` warning|P3 验收Worker匿名默认导出对象；合法模块，无功能故障，命名仅利于调试/风格。|`ec808214`；基线行20；文件未改|
|[workers/analysis/src/core.ts:163:83](https://github.com/Paikchu/Spontra/blob/0a45a4238df15f6d6bc9d8c766cd0614a1d10d7b/workers/analysis/src/core.ts#L163)|`@typescript-eslint/no-unused-vars` warning|P3 兼容参数now默认Date.now()但函数不使用；不会驱动业务时钟。移除须先查调用兼容，不能仅为数量删接口。|`c7b6180f`；基线行163；文件未改|
|[workers/analysis/src/operations.ts:137:91](https://github.com/Paikchu/Spontra/blob/0a45a4238df15f6d6bc9d8c766cd0614a1d10d7b/workers/analysis/src/operations.ts#L137)|`@typescript-eslint/no-unused-vars` warning|P3 workflowInstanceId参数仍在函数签名但内部不使用；本次修改了该文件其他部分，该行本身旧有。未证明运行时错误。|`d7cb1d52`；基线行137；文件本轮改过，报错行未变|
|[workers/analysis/src/pi/host.ts:31:26](https://github.com/Paikchu/Spontra/blob/0a45a4238df15f6d6bc9d8c766cd0614a1d10d7b/workers/analysis/src/pi/host.ts#L31)|`@typescript-eslint/no-explicit-any` error|P2 异构recipe/state/loader边界显式any绕过类型检查；无直接运行时操作，但降低错误发现能力；长期以泛型或unknown+校验治理。|`de7ba84b`；基线行29；文件本轮改过，报错行未变|
|[workers/analysis/src/pi/host.ts:32:18](https://github.com/Paikchu/Spontra/blob/0a45a4238df15f6d6bc9d8c766cd0614a1d10d7b/workers/analysis/src/pi/host.ts#L32)|`@typescript-eslint/no-explicit-any` error|P2 异构recipe/state/loader边界显式any绕过类型检查；无直接运行时操作，但降低错误发现能力；长期以泛型或unknown+校验治理。|`de7ba84b`；基线行30；文件本轮改过，报错行未变|
|[workers/analysis/src/pi/host.ts:32:23](https://github.com/Paikchu/Spontra/blob/0a45a4238df15f6d6bc9d8c766cd0614a1d10d7b/workers/analysis/src/pi/host.ts#L32)|`@typescript-eslint/no-explicit-any` error|P2 异构recipe/state/loader边界显式any绕过类型检查；无直接运行时操作，但降低错误发现能力；长期以泛型或unknown+校验治理。|`de7ba84b`；基线行30；文件本轮改过，报错行未变|
|[workers/analysis/src/pi/host.ts:49:31](https://github.com/Paikchu/Spontra/blob/0a45a4238df15f6d6bc9d8c766cd0614a1d10d7b/workers/analysis/src/pi/host.ts#L49)|`@typescript-eslint/no-explicit-any` error|P2 异构recipe/state/loader边界显式any绕过类型检查；无直接运行时操作，但降低错误发现能力；长期以泛型或unknown+校验治理。|`de7ba84b`；基线行44；文件本轮改过，报错行未变|
|[workers/analysis/src/sec/analysis.ts:10:7](https://github.com/Paikchu/Spontra/blob/0a45a4238df15f6d6bc9d8c766cd0614a1d10d7b/workers/analysis/src/sec/analysis.ts#L10)|`@typescript-eslint/no-unused-vars` warning|P3 常量通过typeof SEC_CANONICAL_SERIES_IDS[number]生成有效类型联合；并非无用定义，属规则对仅类型用途值声明的报告。不得删有效联合。|`1dad48a4`；基线行10；文件未改|

优先顺序：先按真实交互旅程决定是否优化effect状态重置，再整理Pi异构类型边界；匿名导出与有意保留参数属于低风险规范项。当前没有从这些lint结果确认P0/P1线上缺陷，error是规则严重级别，不等于线上故障级别。

机器证据：`/tmp/spontra-lint-current.json`、`/tmp/spontra-lint-baseline.json`、`/tmp/spontra-lint-provenance.json`。逐条包含准确列号、原行文本、blame提交和基线匹配行。