# SEC 披露材料与表格

每个 accession 对应一份材料快照。它包含正文和全部附件的来源清单、Markdown、独立 CSV、完整事实、来源映射与覆盖记录。`filing.material.ready` 是分析会话启动的材料条件。

## 准备材料

SEC 网关读取 filing index 和完整 submission，合并文档清单并归档原始字节。ZIP 条目和同次提交的引用图片也进入清单。下载和解析进度按文件保存，任务恢复后继续未完成项。

预处理 Agent 根据来源块 ID 组织材料并填写表格 description。代码复制原文与表格，不让 Agent 重写金额。业务事实、数值、定义、条款和不确定内容保留。纯通用声明的过滤记录包含来源与理由。

原件、解析内容、最终材料分别核对覆盖。表格同时核对行列含义、期间、单位、符号、维度和表注。未解析内容或无法核对的视觉提取使材料保持 blocked，不得视为完整。

材料版本包含来源哈希、解析版本与编排版本。R2 保存完整 Markdown 和不可变材料索引，D1 保存进度与当前指针。大段原文以字节范围关联到完整文档，按页读取，避免将全部附件同时复制到会话内存。读取已经固定的版本不查询最新段落内容。

## 读取 Markdown 和 CSV

分析工具统一使用以下接口。

| 工具 | 读取内容 |
| --- | --- |
| `read_filing_markdown` | 本次披露的 Markdown，按来源锚点或游标续读 |
| `find_filing_tables` | 按文件、日期、表名和 description 找表 |
| `read_filing_table` | 独立 CSV、单位、报告期、表注和来源 |

长文与长表返回续读游标。CSV 分页重复表头，不省略后续行。数字查询和计算使用同版本事实。

每张有实质信息的表保存为 `ticker_提交日期_Form_表格名称.csv`。提交日期使用 SEC filingDate，报告期另存。内部路径包含 accession、版本与 tableId，同名表不会覆盖。CSV 按原始显示文本输出，保留空白、零、精度与括号负数。description 和表注保存在表格目录，不占用 CSV 数据行。

## 验证真实披露

`scripts/sec-material-acceptance.ts` 调用验收 Worker，重新发现 AMZN 最新原始 8-K 和 10-K，执行预处理与真实报告会话，并从正式接口读回成品。

验收导出 Markdown、CSV、表格目录、来源清单、覆盖结果、报告与工具记录。新 runId 和 rewrite 禁止旧会话或旧报告满足本次验收。预算耗尽后的强制结算、缺失来源、旧读取工具或省略实质内容的降级均不能通过。

生产验收入口仅由 `workers/analysis/scripts/sec-material-acceptance-worker.ts` 的临时包装提供，并使用独立访问密钥。正常入口不包含验收路由。
