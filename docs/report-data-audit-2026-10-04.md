# ORCL 财报数据审计与补齐核验 — 2026-10-04

## 执行范围与状态

本报告基于只读生产审计、重新下载的 SEC 原件、现行代码复现、修复候选独立核验及生产补齐后的公开 API 复核。**主代理已于 2026-10-04T11:02:22.339Z 完成获授权的 ORCL 收入历史回填；公开端点已确认八季均含四个顶层类别及四个子项。代码尚未提交、合并、推送或部署。**

用户授权修复代码和补齐 ORCL 财报数据，未授权发布。原工作目录 `/Users/max/Developer/Spontra` 的已有未提交内容保留；实施副本 `/tmp/spontra-orcl-financial-coverage` 以 `origin/main` 提交 `5dc5bb455e05eddd6e0160f939bcbf7045e876cb` 为基线。唯一远程的 fetch/push 均为 `https://github.com/Paikchu/Spontra.git`。

本轮具体缺失是业务地图中八季收入有五季仅显示灰色总收入，并非五季收入数字完全没入库。必须区分三层：生产已存的三大报告分部、官方披露的更细产品收入、图表按当前业务分类匹配的显示结果。

## 实际生产链路

- 分析代码已经迁入 Spontra；当前代码配置的独立分析 Worker 名为 `spontra-analysis`，主应用及 admin 的 Service Binding 均指向该名称。本次直接核验的是下述分析 D1 与公开读取链路，未单独核验已部署 Worker 的身份；分析 D1、部分 Workflow 和 bucket 仍保留 `earning-report-analysis` 历史名称，无需另改旧 earning-report-analysis 仓库。
- Cloudflare account ID：`32ed059d49b57175de6d22f810cb70f9`；分析 D1：`earning-report-analysis-sec-web`，UUID `3c917a4c-3562-4de1-8b21-586fa384e63f`，查询确认版本为 `production`、区域 `WNAM`。这些是资源标识，不是凭证。
- 独立业务图 `spontra-business-map` 读取主应用公开业务图 API，主应用通过现有授权后端读取分析结果。账本 D1 与分析 D1 没有混用。
- 公开证据端点：`https://spontra-business-map.max-zhangyuchen.workers.dev/api/business/v1/companies/ORCL`。只读 GET 返回 `ready`，完整 flow 保留最近两季，收入 history 返回最近八季。修复前响应、HTTP headers 在 `/tmp/spontra-orcl-audit/public-before.json` 与 `public-before-headers.txt`。
- 当前完整 flow 指针为 `0001341439:1791107166833`，发布时间 `2026-10-04T09:48:08.947Z`；完整两季为 2026-08-31 与 2026-05-31。
- `sec:revenue-history:v1:0001341439` 更新于 `2026-10-04T08:58:06.729Z`，实际保存 11 季，公开投影限制八季。对应游标已完成 `14/14` 文档，不能把这次缺口归因于任务尚未跑完。
- `sec:business-flow:v2:ORCL` 是旧缓存，仅两季，不能单独用它推断线上 history 覆盖。最初调查发现此缓存后，已进一步核对完整版本表与独立 history 并修正结论。

查询使用已授权 Cloudflare connector，所有审计 SQL 的 `rows_written=0`。本机 Wrangler 缺少登录上下文，未新增凭证，改用已有连接完成只读审计。

## 已复现根因

1. **展示按当前分类强制匹配。** 基线 `apps/business-site/src/trend-model.ts` 的 `buildColumns` 只有旧季度所有分类都能一一对应当前四大类、并且加总相等时才绘制分部。旧季度存储为 `CloudAndSoftwareBusinessMember`、`HardwareBusinessMember`、`ServicesBusinessMember`，当前为 cloud/software/hardware/services；匹配失败后整柱降级为公司总收入，隐藏了已取得的分部。
2. **收入提取被无关的费用完整性阻断。** 真实 2025-11-30、2026-02-28 报表有完整 Cloud/Software 收入细分，`parseSecBusinessFlow` 的 `revenueSplitComplete=true`，但固定费用映射分别少 427、173 百万美元，`expenseSplitComplete=false`。`buildPublishedBusinessQuarter` 因任何完整性项失败便拒绝整季，收入历史跟着退回 generic 提取。2025-08-31 自身披露也少映射 415 百万美元费用，但后来 2026-08 对比列费用完整，因此该历史季度又获得了细分类。
3. **固定收入标签无法覆盖旧披露。** 2024-11、2025-02 原件使用 `CloudServicesAndLicenseSupportRevenue`、`CloudLicenseAndOnPremiseLicenseRevenue` 等自定义概念，固定 profile 只识别较新的 CloudApplications/CloudInfrastructure/SoftwareLicense/SoftwareSupport。generic 仅映射少数合并标准收入概念，所以回退到较粗报告分部。
4. **官方补充季度表没有被历史收入路径完整利用。** FY2026 Q4 的 EX-99.1 含 Fiscal 2025/2026 的明确 Q1–Q4 独立列及 TOTAL 列；八季范围中七季可从这里直接提取最新官方产品口径，无需推断拆分比例。2025-05此前记为 FY−前九个月推导，本次候选使用官方直接季度列。

源文件读取成功、收入总数与官方一致；问题主要在收入解析与图表展示层。原报告不是未披露，也不应通过填零处理。已保存 `/tmp/spontra-orcl-audit/profile-audit.json`，含逐源收入/费用完整性、拒收原因及金额差额，复现脚本为同目录 `profile-audit.ts`。

FY2025 10-K 另触发 `RESTATEMENT_REVIEW_REQUIRED`：原件描述 prior year balances reclassified，接着说明未影响 revenue、income from operations 或 net income；现有规则只认特定“no impact”表述，可能过度阻断。该现象记录为解析边界，不因补齐收入而泛化取消重列审查。

## 补前逐季覆盖

金额单位为 USD 百万；日期是实际季度截止日，不按日历年强行重标财年。三类为“云与软件/硬件/服务”；四类为“云/软件/硬件/服务”。

| 季度截止 | 总收入 | 生产存储分类 | 补前图表 | 补前口径 |
|---|---:|---|---|---|
| 2024-11-30 | 14,059 | 3 类 | 灰色公司总收入 | 直接披露 |
| 2025-02-28 | 14,130 | 3 类 | 灰色公司总收入 | 直接披露 |
| 2025-05-31 | 15,903 | 3 类 | 灰色公司总收入 | FY−前九个月推导 |
| 2025-08-31 | 14,926 | 4 类 | 四类堆叠 | 直接披露 |
| 2025-11-30 | 16,058 | 3 类 | 灰色公司总收入 | 直接披露 |
| 2026-02-28 | 17,190 | 3 类 | 灰色公司总收入 | 直接披露 |
| 2026-05-31 | 19,184 | 4 类 | 四类堆叠 | 直接披露 |
| 2026-08-31 | 19,345 | 4 类 | 四类堆叠 | 直接披露 |

完整修复前对象：`/tmp/spontra-orcl-audit/quarterly-before.json`；已用线上公开 API 与生产 D1 两端独立比对。原用户截图由主代理查看，审计表中的三彩五灰与截图一致。

## 补后：官方披露的逐季细项

下表仍为 USD 百万。每行总收入等于四个顶层分类；云等于云应用加云基础设施；软件等于软件许可加软件支持。**这些是发行人公开的产品/服务类别，不能自动等同于管理层报告分部、客户类别或单个产品。**

| 截止日 | 云 | 云应用 | 云基础设施 | 软件 | 软件许可 | 软件支持 | 硬件 | 服务 | 总收入 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2024-11-30 | 5,937 | 3,503 | 2,434 | 6,064 | 1,195 | 4,869 | 728 | 1,330 | 14,059 |
| 2025-02-28 | 6,210 | 3,558 | 2,652 | 5,926 | 1,129 | 4,797 | 703 | 1,291 | 14,130 |
| 2025-05-31 | 6,737 | 3,742 | 2,995 | 6,968 | 2,007 | 4,961 | 850 | 1,348 | 15,903 |
| 2025-08-31 | 7,186 | 3,839 | 3,347 | 5,721 | 766 | 4,955 | 670 | 1,349 | 14,926 |
| 2025-11-30 | 7,977 | 3,898 | 4,079 | 5,877 | 939 | 4,938 | 776 | 1,428 | 16,058 |
| 2026-02-28 | 8,914 | 4,026 | 4,888 | 6,119 | 1,150 | 4,969 | 714 | 1,443 | 17,190 |
| 2026-05-31 | 9,913 | 4,126 | 5,787 | 6,824 | 1,881 | 4,943 | 924 | 1,523 | 19,184 |
| 2026-08-31 | 11,607 | 4,219 | 7,388 | 5,550 | 655 | 4,895 | 774 | 1,414 | 19,345 |

独立核验采用 Python 读取原 EX-99.1 的第 18 个 HTML table（零基索引），先确认 Fiscal 2025/2026、Q1/Q2/Q3/Q4/TOTAL 表头，只读取对应季度列，排除 TOTAL 与增长率列；最新 2026-08 使用真实 iXBRL concept/context/dimensions 核对。8 季 × 9 个金额 = **72 项全部一致**。所有根/子加总通过、所有季度总收入与补前一致，未插入零、未将年累计当单季。

- 候选存储 payload：`/tmp/spontra-orcl-audit/revenue-history-candidate.json`。
- 候选公开八季投影：`/tmp/spontra-orcl-audit/revenue-history-after-public.json`。
- 独立验证结果：`/tmp/spontra-orcl-audit/candidate-independent-verification.json`。
- 独立验证脚本：`/tmp/spontra-orcl-audit/verify_candidate.py`。
- 每份输入解析结果：`/tmp/spontra-orcl-audit/revenue-parser-source-audit.json`。

2024-11 至 2026-05 候选优先采用 2026-06-10 发布的历史产品口径；2025-08 与 2026-08 采用 2026-09-11 的 10-Q。原始历史快照保持可恢复；不以新名称覆盖或伪装发行人当期使用的旧概念。FY2025 Q4 的 15,903 及所有分类均来自直接季度列，因此候选 `basis=reported`。

## 原始证据、下载与哈希

2026-10-04 重新下载八份季度/年度报告及两份 Q4 EX-99.1。九份与本机旧 SEC 缓存逐字节相同；2024-11 原件为此次补下载。HTTP 均成功。完整 URL/本机路径/字节数/SHA-256：`/tmp/spontra-orcl-audit/source-verification.json`。提取出的原始 revenue concepts、contexts、期间、币种、维度：`revenue-source-facts.json`。

下列哈希针对下载的原 HTML 字节，不针对清洗后的文本。

- [000095017025037143/orcl-20250228.htm](https://www.sec.gov/Archives/edgar/data/1341439/000095017025037143/orcl-20250228.htm) — 3,474,846 bytes；SHA-256 `2f543c08b4b01e8925351f29af257de947f762939256518e9817cb4589fa6a3d`。
- [000095017025087926/orcl-20250531.htm](https://www.sec.gov/Archives/edgar/data/1341439/000095017025087926/orcl-20250531.htm) — 6,549,795 bytes；SHA-256 `b10c890861ee10fd441b2f05fef670c3fff1b0dd077336202ca4ad2ad46e64e3`。
- [000119312525200095/orcl-20250831.htm](https://www.sec.gov/Archives/edgar/data/1341439/000119312525200095/orcl-20250831.htm) — 2,625,929 bytes；SHA-256 `cc1ef96d99f8aa620203ba4259e127cf64d10ce49777bdf85f0af5ea107b4037`。
- [000119312525315925/orcl-20251130.htm](https://www.sec.gov/Archives/edgar/data/1341439/000119312525315925/orcl-20251130.htm) — 3,771,706 bytes；SHA-256 `5a35f57a4fd0ba54b4629f0b17afe12b564b902bdb1817cfc10993c67802d6f9`。
- [000119312526101045/orcl-20260228.htm](https://www.sec.gov/Archives/edgar/data/1341439/000119312526101045/orcl-20260228.htm) — 4,172,940 bytes；SHA-256 `cf5dd26bff13e33b58e3209a74da36909ebca899da936bc1b578675eab8ad62e`。
- [000119312526277521/orcl-20260531.htm](https://www.sec.gov/Archives/edgar/data/1341439/000119312526277521/orcl-20260531.htm) — 6,874,045 bytes；SHA-256 `2b7d41509b226bbff3c9e34739d0ddd66d9b4dce909b5ed81791adea13afb9aa`。
- [000119312526389274/orcl-20260831.htm](https://www.sec.gov/Archives/edgar/data/1341439/000119312526389274/orcl-20260831.htm) — 2,709,061 bytes；SHA-256 `8547e1c6710c3e915663b8d50286b36857d2921797ccbe4dea333ee130c3a5e0`。
- [000095017025084831/orcl-ex99_1.htm](https://www.sec.gov/Archives/edgar/data/1341439/000095017025084831/orcl-ex99_1.htm) — 1,780,364 bytes；SHA-256 `4d5dac6577f59ef7ed565f2c9a93cf98bbe69f17c5f6d5c3fb48add81dcf5e0c`。
- [000119312526265848/orcl-ex99_1.htm](https://www.sec.gov/Archives/edgar/data/1341439/000119312526265848/orcl-ex99_1.htm) — 1,956,608 bytes；SHA-256 `0cac2cc7463bfcdfd9c5bc4786699a13445d2d6a316f231c137b12044575c72c`。
- [000095017024134973/orcl-20241130.htm](https://www.sec.gov/Archives/edgar/data/1341439/000095017024134973/orcl-20241130.htm) — 3,224,432 bytes；SHA-256 `b13af1037d86b661df80d558df0540c657ddd6cf1f89ad4d2f7c9abc6aaa036e`。

Oracle IR 对照页：[FY2026 Q4 官方业绩公告](https://investor.oracle.com/investor-news/news-details/2026/Oracle-Announces-Record-Q4-and-FY-2026-Results-Driven-by-Cloud-Infrastructure--Cloud-Applications/default.aspx)，日期 2026-06-10，与 SEC 附件相同季度表相符：FY2026 Q4 云 9,913、软件 6,824、硬件 924、服务 1,523、总收入 19,184 百万美元。

另已下载 [SEC Company Facts](https://data.sec.gov/api/xbrl/companyfacts/CIK0001341439.json)，本机 `/tmp/spontra-orcl-audit/companyfacts-ORCL.json`，3,962,105 bytes。该来源不能替代公司自定义维度、非 XBRL 附表及正文披露。

## 可审计提取覆盖与边界

原有限 canonical registry / flow profile 不是“全部财报”。全量披露提取要记录每个输入文档、SHA、上下文/单位/维度、已提取/不支持/失败项，三大报表只是其中一部分。本次全 iXBRL 审计输出见 `/tmp/spontra-orcl-audit/full-disclosure-inventory-summary.json`，包含标准及自定义 facts、期间、币种单位、附注 text blocks 与文档出处；年度完整 inventory 可达十余 MB，适合对象存储，不能直接塞进 D1 行。

| 类别 | 本次审计依据 | 必须保留的限制 |
|---|---|---|
| 三大报表 | 原始 numeric iXBRL、单位、instant/duration 及 canonical 投影 | 不把所有 facts 等同于已核验语义指标；无值不填零 |
| 分部/产品/地区 | 原始维度 facts + 明确季度补充表 | 不把重叠维度重复加总；保留原披露分类 |
| 自定义指标 | 自定义 taxonomy facts、RPO 等原文表述 | 不擅自改作 GAAP 指标；缺单位/期间应标缺口 |
| 附注/会计政策 | text blocks、原始 HTML 与定位信息 | 文本留存不等于每句语义已结构化；需区分提取与分析 |
| 非 XBRL 附表 | 有明确表头的确定性表格解析 | 无法确定列、缩放或季度时保留原文并标不支持 |
| PDF/图片/附件 | 有限能力需明确标注 | 未配置 OCR/语音转录的材料不能声称完整识别 |

## 恢复快照与精确写入边界

审计备份均在 `/tmp/spontra-orcl-audit`，需在清理临时目录前归档：

- `sec-cache-before-exact.json`：收入 history 与 cursor 的**原始 payload 字符串**、fetched_at、SHA-256，可直接参数化恢复。
- `revenue-history-before.json`、`history-cursor-before.json`：便于人工阅读的同等数据。
- `complete-version-before.json`、`complete-flow-before.json`：当前完整 flow 版本及原 payload，完整 payload SHA-256 `116662545cf7e200b3a55aa6068d9bae1ac0db3a89e89218f5e003797ee43af9`。
- history 原 payload SHA-256 `4a0a78e595a38be3e10a41dfa91cc25438cd40d15a2cd856ca325f19fba8c54d`；cursor 原 payload SHA-256 `8e297e250881b15aa8aebb6fef1451dec437888a7ec3db6e7a862571cb343cb8`。

允许主代理考虑的最小数据补齐范围是 `sec_cache` 中单个 ORCL history key；无需修改账本、其它公司、SEC 原 facts、完整 flow 当前指针、账户权限或凭证。先重新读取目标 row，确认原 payload/fetched_at 与备份一致；不一致则重新生成差异和备份，不盲覆盖 Cron 新结果。

安全只读核对示例（通过已有授权的 Cloudflare D1 query API，参数化，不嵌入凭证）：

```json
{
  "sql": "SELECT cache_key, payload, fetched_at FROM sec_cache WHERE cache_key = ?",
  "params": ["sec:revenue-history:v1:0001341439"]
}
```

写入宜用比较后交换：`UPDATE sec_cache SET payload=?, fetched_at=? WHERE cache_key=? AND payload=? AND fetched_at=?`。要求 `changes=1`；`0` 表示并发更新，应停止并重新核对。每一步记录 API 状态和 rows_written。此处仅是方案，不构成已执行写入的证据。

回滚同样对“本次写后 payload/fetched_at”加条件，只有仍为本次值才恢复 `sec-cache-before-exact.json` 的原字符串与时间；若已被 Cron 或其它任务修改，不覆盖新的有效结果。没有理由回滚整个 D1 数据库。

**未发布代码的持久性限制：** 生产旧历史刷新每天会重新运行；旧 `mergeHistory` 同等来源日期可能把更细候选再次覆盖为较粗数据。实际补齐与本地修复不代表防回归代码已上线。不得未经授权改 Cron、权限或执行部署来回避该边界。

## 实际远程写入与线上复核

主代理执行了用户已授权的 ORCL 数据补齐，审计代理随后独立进行公开只读核验：

- 目标环境仍为上述生产分析 D1；只修改 `sec:revenue-history:v1:0001341439` 最新八季，保留原 11 季数量以及更早三季，不增加更早候选季度。
- 主代理先在同库保存远程备份 key `admin:backup:orcl-revenue-history:2026-10-04:4a0a78e595a38be3`；本机完整 before/after 字符串及精确 hash 仍保存在 `backfill-plan.json`。备份与更新两步均 API success；各逻辑操作 `changes=1`，写入元信息中 backup rows_written=2（包含索引等内部统计）、target rows_written=1。
- 写后 `fetched_at=2026-10-04T11:02:22.339Z`；原 payload SHA-256 `4a0a78e595a38be3e10a41dfa91cc25438cd40d15a2cd856ca325f19fba8c54d`，新 payload SHA-256 `717f4b490faf3ed47a3dc941e8d8b8b10e3455961bf649096cf277f4c0198c51`。
- 新 payload 为 35,327 字符 / 36,245 UTF-8 bytes；生产参数化 SQL `payload = ?` 回读得到 `exactMatch=1`，远程备份同样 exact match 通过（主代理证据）。`production-backfill-readback.json` 受 connector 长字符串截断，仅作诊断，**不能用作恢复备份**。
- 实际批准数据 `revenue-history-approved-after.json`；写入结果 `production-backfill-result.json`；可恢复的精确前后数据 `backfill-plan.json`、`sec-cache-before-exact.json`。
- 公开 GET 于 `2026-10-04T11:04:22Z` 返回 HTTP 200、`ready`，history 更新时间吻合本次写入；八季全部四个顶层和四个子项，共 72 个金额逐值等于批准结果，所有父子及根金额加总正确。完整 flow 对象与修复前完全一致。
- 完整公开响应 `public-after.json`（49,037 bytes）、响应头 `public-after-headers.txt`、独立复核 `public-after-verification.json` 均位于审计目录。界面地址：[ORCL 业务地图](https://spontra-business-map.max-zhangyuchen.workers.dev/companies/ORCL)。截图由主代理另行保存。

这确认了数据回填的线上结果，不代表本地 admin / 提取修复已上线。对旧版历史 Cron 做无写入回放后，八季金额和分类均保留；同日期合并会使三季新增 lineage/presentation 元数据丢失。并非下次运行必然再次缺五季。新版本的细分类保护规则与独立收入提取用于防止后续粗分类回退。

## 本地实现与本轮验证

实现位于分支 `codex/orcl-financial-coverage`，工作目录 `/tmp/spontra-orcl-financial-coverage`。未提交、推送或运行发布命令；原工作目录中的 marketing、产品文档及其他已有修改保持原状。

- 收入历史从完整利润流校验中独立提取，保留旧类别及明确披露的历史季度列。合并时避免同来源日期的粗分类覆盖已有细分类；图表仍可显示原披露分类。来源或归档临时失败保留检查点、最多三次尝试，耗尽后明确部分完成；恢复成功清除临时错误。
- Inline XBRL 档案保留所有遇到的标准与公司自定义事实、精确十进制数值、nil、不支持项、instant/duration 期间、单位、缩放、显式/typed 维度、续接文本、附注关系和来源字符位置。原始 HTML 与完整 inventory 写入现有 R2，再发布 D1 摘要指针；相同源内容与解析版本重复运行幂等。
- 管理页面复用已有 HttpOnly 会话与同源写入限制，提供公司/季度/指标、缺失过滤、来源档案分页、单次新增公司补全或分析、后台状态、部分失败、重试和步骤边界取消。任务持久化并按 ticker 及已识别 CIK 串行；同一发行人的不同股票代码不能互相重置历史游标。分析是否可运行继续服从现有全局开关。分析等待及无锁的股类等待不会阻塞普通采集；共享收入/完整图按请求代码投影前，严格核对 CIK 及所有 SEC 原文出处，不修改原始快照。
- 本轮真实披露验证包含七份 10-Q/10-K，遇到事实数依次为 882、2,105、621、886、1,065、2,195、710，均全部保留。最新 2026-08 原件为 **710/710 保留、677 成功解析、2 nil、31 不支持转换**；含 620 标准、90 自定义、238 含维度、22 typed dimensions，23 个 continuation 全部解析。不支持项保留原文并计入缺口，未伪造数值。

### 明确的覆盖限制

这是一套可审计的披露事实提取与有限语义投影，不能称为所有财报信息均已理解：三大报表的完整语义分类、展示/计算 linkbase 对照、全部非 XBRL 表格及附注语义、PDF/图片 OCR 尚未完成。当前历史扫描沿用最近 820 天、最多 14 份 SEC filing（及已识别附件）的预算；不是发行人全部历史材料下载器。原件大于 12 MB 时拒绝归档并显示失败，不静默截断。档案列表当前返回最新 200 份文档，事实按文档分页。

本次生产实际写入**仅限 ORCL 收入历史**，没有上线新的全披露档案、admin 页面或任务表，也没有运行付费分析。新档案由代码发布后正常采集/管理员补全逐步生成；本轮完整原件与覆盖清单留在审计交付包中。

### 测试记录

Pipeline 全套、主应用单元测试、类型检查、架构边界及主应用/admin/业务图构建结果见审计目录中的日志和 `validation-summary.md`。主站 rendered-html 本轮为 39/42；三个失败是旧产品描述、旧账本比例、旧期权移动端缩进断言。在干净 `main` 的 `/tmp/spontra-business-site` 完整重跑同套件，同样 39/42，失败项完全相同；涉及文件本次未修改。日志分别为 `rendered-tests.log` 与 `rendered-baseline-tests.log`。

浏览器交互使用明确标记的本地 fixture，不假冒线上管理数据。验证了缺失过滤、事实分页与细节、503 模糊结果后同一 UUID 重试、取消、刷新后任务保留、新增公司以及移动端无页面横向溢出。详细执行说明为 `admin-local-fixture-verification.md`；请求日志与 fixture 随包交付。线上 ORCL 截图为 `orcl-production-after.jpg`，admin 截图文件名含 `local`。

### 待授权发布范围

需要同步发布 Pipeline、独立 admin、业务图三个组件，对应仓库两个既有自动构建目标；新增分析库迁移为 `0014_financial_maintenance.sql`。当前 `package.json` 的 Pipeline CI 发布入口会先执行分析库迁移再核验；本地未应用生产迁移。后续获授权发布时按仓库规则推送 `origin/main`，分别核验两个构建目标及真实 admin 会话/维护任务。不得用本地手动部署替代。

## 追加：旧 Cron 接入新模型

旧十分钟业务图 bootstrap 与旧认证刷新入口已改为向统一财报队列提交请求；两分钟消费者负责原文归档、事实清单、完整快照及空闲历史采集。旧入口不再直接写旧业务图缓存。加入按 CIK 的并发去重、24 小时自动重试冷却和 admin 任务所有权保护；认证、白名单及采集开关继续生效。HTTP 手动刷新变为 202 异步响应，暂停或维护占用返回 409。

新增四项端到端/并发测试，Pipeline 全套 **503/503** 通过，类型与架构检查通过。日志 `pipeline-cron-final.log`。用户随后明确授权本次范围提交并按正式 CI 上线；实际发布结果另记部署证据，不将本地测试视作线上验证。
