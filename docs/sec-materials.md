# SEC 披露材料与表格

每个 accession 对应一份材料快照。它包含正文和全部附件的来源清单、Markdown、独立 CSV、完整事实、来源映射与覆盖记录。`filing.material.ready` 是分析会话启动的材料条件。

## 准备材料（L1 零 LLM 原件层 + L2 全量事实卡片层）

SEC 网关合并提交目录、filing index 和完整 submission，归档原始字节。目录原 JSON 的地址、哈希、文件名及 SEC 生成页面的排除理由冻结进覆盖记录。ZIP 递归解包，同次提交的引用图片也进入清单。下载和解析进度按文件保存，任务恢复后继续未完成项。

**L1 原始证据层（0 Token）**完全由确定性代码完成：按主文档原生目录、业务附件（如 `EX-99`）与其余附件的顺序组织 `filing.md`，并将 `code` 类型技术原件统一隔离至文末 `Technical & Submission Originals` 分区；同时仅对字面与表格数据完全一致的块做确定性去重。L1 保留 100% 原文与精确字节锚点，严禁模型改写原文与数字。

**L2 结构化事实卡片层（DeepSeek 1M 单次全量）**由 `MATERIAL_BRIEF_WORKFLOW` 异步执行：一次性读入 L1 解析后的全量正文与表格（超大 10-K 超过字符阈值时自动折叠非业绩长合同附件），产出 `brief.json`、`brief.md`（包含披露周期元数据、核心主线、标准化指标、指引/口径变更、附注风险、行业信号）以及高检索密度的表格描述目录，所有字段均挂载可验证的 L1 `blockId`/`tableId` 溯源锚点。L2 不修改不可变的 L1 `index.json`，在 Admin 后台 `/materials` 页面支持单文件按需启动、查看及点击锚点直跳 L1 原文与 CSV 核对。

原件、解析内容、最终材料分别核对覆盖。HTML 使用独立原始 token 扫描核对可见原文、定位、表格和图片，不共享正文解析器的 DOM 基准。表格同时核对行列含义、期间、单位、符号、维度和表注。未解析内容或无法核对的视觉提取使材料保持 blocked，不得视为完整。

材料版本包含来源哈希、目录依据、解析版本与布局版本。R2 保存完整 Markdown、L2 事实卡片与不可变材料索引，D1 保存进度、L2 状态与当前指针。复杂表格保留原 HTML，PDF 逐页保存原图和文本坐标。大段原文以字节范围关联到完整文档，按页读取。读取已经固定的版本不查询最新段落内容。

## 读取 Markdown、Brief 和 CSV

分析工具统一使用以下接口。

| 工具 | 读取内容 |
| --- | --- |
| `read_filing_brief` | 本次披露的 L2 结构化事实卡片与表格检索目录（若已生成） |
| `read_filing_markdown` | 本次披露的 L1 原文 Markdown，按来源锚点或游标续读 |
| `find_filing_tables` | 按文件、日期、表名和 description 找表 |
| `read_filing_table` | 独立 CSV、单位、报告期、表注和来源 |

长文与长表返回续读游标。CSV 分页重复表头，不省略后续行。每页提供 `#rows:start-end` 来源和 `#cell:row:column` 单元格引用。行号从首条数据行的 0 开始，CSV 第 0 列是层级行名。数字查询和计算使用同版本事实。

每张有实质信息的表保存为 `ticker_提交日期_Form_表格名称.csv`。提交日期使用 SEC filingDate，报告期另存。内部路径包含 accession、版本与 tableId，同名表不会覆盖。CSV 按原始显示文本输出，保留空白、零、精度与括号负数。独立目录包含 description、单位、表头、表注、行列数、原件定位、Markdown 范围和 CSV 哈希，不占用 CSV 数据行。

## 报告发布复核

可重算的算式和正确的来源链接，不能证明口径或结论正确。`finish` 在逐块检查后执行独立全文审核。审核使用固定材料的全部业务正文、表格、表注、规范化 XBRL 和未归类残余内容，并检查报告实际使用的计算依赖、维度、单位和图表。

每条已使用的计算必须有独立口径结论。错误、未建立的口径、虚假的缺失披露和未完成审核均阻止发布。Agent 通过正常研究、计算和编辑工具修正，然后再次调用 `finish`。披露报告没有自动删句、占位或安全版式降级发布。

审核收据按完整证据、模型、策略、响应 schema 和报告语义哈希缓存。条件写入保留首个完整结果；未改报告的失败收据不能被局部争议裁定绕过。纯样式调整可复用相同语义的审核结果。收据及完整输入保存到 R2，D1 保存检查摘要。

## 验证真实披露

`scripts/sec-material-acceptance.ts` 可按 ticker/form 验证真实材料和报告，默认准备 CRWV、ORCL 的当前及前一期 10-Q，为当前季报启动新的分析。客户端连续读回 Markdown，并核对原件、CSV、来源引用和报告正式读回结果。

验收导出 Markdown、CSV、表格目录、来源清单、覆盖结果、报告、完整审核收据和模型用量。客户端核对审核内容与实际发布 HTML、材料版本及计算集合一致。新 runId 和 rewrite 禁止旧会话或旧报告满足本次验收。预算耗尽后的强制结算、缺失来源、旧读取工具或省略实质内容的降级均不能通过。

运行记录包含每次工具调用和当期检查。现有 D1 工具参数日志上限为 2,000 字符；完整报告、计算状态和全文审核输入另存。用量账本包含模型、effort、token、耗时和结果，不包含模型思维过程或密钥。

生产验收入口 `/admin/material-acceptance/*` 由管理会话鉴权。本地运行 `wrangler dev --config workers/analysis/scripts/wrangler.acceptance-proxy.jsonc` 后，验收脚本通过仅监听 localhost 的代理调用远端 AdminGateway，复用生产绑定；本地无需复制模型密钥。独立本地材料环境仍由 `workers/analysis/scripts/sec-material-acceptance-worker.ts` 提供。

两份真实 AMZN 披露的覆盖数量、正常报告发布、独立复核和正式读回结果见 [AMZN SEC 全链路验收](sec-material-acceptance.md)。
