# Reader v2 实施与验收

日期：2026-09-22。

## 已实施

- 两期数据使用紧凑横向比较，保留同一零基线、精确金额与期间；多期数据使用真实时间比例，数值标签按图宽稀疏。
- 成稿图文环绕、窄容器单列，来源展开区域独立；修复 768 px 宽度下旧投资含义段落的横向溢出。
- Reader v2 有序内容块与稳定标识：Markdown、图表、已持久化图片、公式、表格、提示及相关研究摘录。v1、旧 presentation 和传统摘要继续兼容。
- Zod 为运行时结构、类型及公开 JSON Schema 的唯一结构定义；无平台依赖的校验放入 `shared/analysis-runtime`，保留 Web/Pipeline 架构边界。
- 正文损坏时恢复兼容正文并保留有效媒体；未知版本回退；资源失败保留说明；Markdown 不执行模型 HTML 或加载模型任意图片 URL。
- `react-markdown`、GFM、CJK、KaTeX 共用；美元单符号不作为公式。公式关闭 trusted commands 并限制展开。
- 完整 Reader 的标题和核心结论保留审稿后的完整文字；过长进入修订，不再经过短事件摘要的硬截断。既存快照已被裁切的文字不能自动恢复。
- 对话侧已提供事件 Schema、纯 reducer、`ReportStreamView` 和 Streamdown 预览组件。尚未接入在线事件持久化/SSE、生成聊天入口或围绕报告追问端点，本轮不进行对话流端到端测试。

图片块引用由应用保存的资源清单。当前 Pipeline `availableAssets=[]`，没有新增图片生成供应商或资产上传服务；不能据此声称模型图片生成链路已完成。公式默认直接排版，不依赖截图。

## 真实 ORCL 本地回放

- accession：`0001193125-26-389274`；财报期末：`2026-08-31`。
- 原发布版本：`sec-analysis.v3:2026-08-31-54372bbf-f437-4265-bdb1-9dcc9ae7050e`，生成于 `2026-09-20T15:13:56.559Z`。
- 7 个正文章节、20 个段落、3 张选中图表；另有 12 条可用趋势、11 个分析节点。
- 原 v1 与仅格式迁移的 v2 均通过解析，0 warnings。20 段正文 SHA256 一致，3 图指标、标题与图注未变；格式迁移不是新模型生成。
- 当前生产构建产物在本地 Workers 运行时加载真实报告快照，读 API 使用只读 fixture，其他页面组件、SSR 与浏览器资源均使用构建产物。
- v1/v2 × 1440/768/390/320 px，共 8 个浏览器场景通过：HTTP 200、SSR 有真实图表、浏览器无异常、13 个页面章节和 3 张图、无横向溢出、来源数据展开和手机目录点击正常。
- 两期资本开支精确值仍为 `8502000000` 与 `28499000000`；桌面图宽 360 px，手机依容器收缩。
- 临时回放输入、截图和机器记录位于 `/tmp/sec-reader-v2-qa/`，不作为产品数据提交。

原报告中存在已保存的标题/要点句尾截断。本次修复防止新报告再次被截断，正式验收需重新生成并检查新版本。

补充的合成媒体组件用例在 1440/390/320 px 通过：图片延迟加载前后尺寸和位置不变、桌面环绕后文字恢复全宽、窄屏单列、长公式仅在自身容器滚动、图片失败保留替代文字与图注。这些用例明确标为 Synthetic，未修改原 ORCL 正文或数值，也不代表模型图片生成链路验收。

## 自动化验证

前端与边界共 31 项：

```sh
npx tsx --tsconfig tsconfig.test.json --test tests/earning-report-rich-text.test.ts tests/sec-report-render.test.tsx tests/sec-reader-visual.test.tsx tests/sec-content-renderer.test.tsx tests/pipeline-boundary.test.ts
```

后端共 74 项：

```sh
node --experimental-strip-types --test tests/pipeline/sec-reader-v2.test.ts tests/pipeline/sec-reader.test.ts tests/pipeline/sec-editorial.test.ts tests/pipeline/analysis-contract.test.ts tests/pipeline/analysis-read-api.test.ts tests/pipeline/sec-d1.test.ts tests/pipeline/sec-reader-market.test.ts
```

类型、边界、构建与 Pipeline dry-run 已通过：`npm run typecheck`、`npm run typecheck:pipeline`、`npm run check:pipeline:boundary`、`npm run build`、`npm run worker:pipeline:check`。

## 线上验收要求

用户已授权通过 `origin/main` 自动部署后在线重新生成。须分别确认主应用和 Pipeline 对应同一提交的自动构建成功，然后启动指定 accession、`requestedBy=manual`、`regenerateReport=true` 的工作流。

验收必须核对新 run、新 `reportVersion`、`generatedAt`、`reader.version=sec-reader.v2`、独立审稿结果及真实文章页；不能把旧报告回放或自动部署成功作为新生成验收通过。对话流暂不测试。

## 线上生成回归发现

首轮线上运行使用 `68616ec`，结构与引用校验拦截了字符串内容块、无合法来源的行情段落及不完整章节，未覆盖旧发布报告。

其中行情引用存在确定性协议缺口：模型输入包含冻结行情，但内容块允许引用集合只有 SEC 证据。现为有效行情快照生成系统来源 ID，写入同一发布快照，并在综合写作、局部修订和独立审稿中使用；其他快照或模型自造的来源 ID 不被接受。该来源仅支持行情字段，不作为 SEC 经营财务证据。内容块补充真实对象示例，字符串块仍须修复后通过严格校验，不能自动包装并编造引用。

这一轮失败是修复依据，不是新版生成验收成功。后续必须重新核对修复提交的自动部署及新实例的实际发布结果。
