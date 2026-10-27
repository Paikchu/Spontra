# Spontra 估值评估：独立开发交接规格 v1

日期：2026-10-27。状态：开发规格草案，未实现、未实测投资效果。本文件补全[构建方案与资料链路](valuation-assessment-design.md)中的产品和方法约定；两份一起交接。若两者对首版行为描述不同，以本文件为准。现有代码事实仍须在实际开发分支核对。

**接手者不需要访问 Mispriced，不需要原对话或截图。需要 Spontra 仓库；生产验收另外需要已配置的 D1/R2/模型服务访问权限。所有实现必须在本仓库完成：Analysis 后端、现有 business-site 网页及 Admin。此次网页落点是用户明确选择，覆盖 AGENTS 对新前端默认放 Harness 的要求。**

Mispriced 只说明方法来源；以下合同、公式、评分约定和页面规格才是开发输入。评分锚点与参数治理是 Spontra v1 的设计选择，不声称复原了 Mispriced 的全部规则，也不声称经过收益回测。定性研究允许不同模型有判断差异，但公式、状态、分数合成与证据边界必须一致。

**1. 范围、完成标准与首版取舍**

用户路径：Admin 开启公司 → 开启该公司「估值评估」 → 后台完成研究 → 公司页第四个页签展示五维评价、三情景估值、论证和来源。所有估值开关默认关闭，运行与展示规则沿用主方案的双开关及全局暂停定义。

交付必须包含实际研究任务、计算器、数据与证据持久化、Admin 控制、公开只读 API、网页渲染和更新流程。静态示例页、只返回 Markdown、人工预填公司分数、只有开关但无执行器，均不算完成。

首版不导入外站数据、不做自动交易、不扩股票覆盖、不新增定时新闻/全市场扫描、不实现假设滑杆或任意历史时刻重算。不保证所有已开启公司都有足够证据；真实的 insufficient 报告是合法结果，捏造完整结果不是。

**2. 报价与时间：消除实时行情歧义**

首版仅在获准的初评或复评过程中获取/选取报价，不增加行情 Cron，不在 GET 中更新行情。复用 `sec/market.ts::fetchSecMarketSnapshot` 与其现有 Yahoo 日线能力；新增估值适配只保留价格、日期、币种、来源和身份，不把其中的估算 P/E 直接当模型输入。

当前解析器会排除交易所当地当天的全部日线。因此 UI 称「参考收盘价 · 日期」，不称实时价格或保证最新成交价。首版可用于评分的报价须满足：正数、同一证券、交易币种与估值一致、明确普通交易日线收盘、报价日在研究日期之前且不超过7个自然日。7日是首版时效政策，沿用现有快照的陈旧提示界限，不是价格可靠性的保证；若公司行动或ADR口径无法对齐，则报价不可用于模型比较。

`assessmentQuote` 随研究版本冻结。首版 `displayQuote` 直接使用该冻结报价，不实现独立持续刷新。以后新增刷新能力时也只能影响比较指标，不能回写冻结评分。主方案中「仅行情变化更新比较」描述的是未来可保持的分离原则，不是本次另有一个已存在的实时行情任务。

有效报价缺失时 `valuationSafety.score=null`、`weightedScore=null`，模型本身如可计算仍显示。参考价或基准价值非正时不计算安全边际百分比；负的模型结果原值保留并说明经济含义。

研究以当次时间为截止，SEC 部分来源只有日期，首版不作盘中历史信息承诺。历史页只展示已保存版本；不使用今天的网页为过去日期重新构造结论。

**3. 五维研究规范：分数、置信度与结论**

每维必须输出：`score: number|null`、`confidence: high|medium|low`、`rationale`、`supportingEvidenceIds`、`counterEvidenceIds`、`gaps`、`nextCheck`。score 取0–10、步长0.5。缺证据用null，0分仅用于已经有充分严重负面证据的情况。

各维使用下面的锚点。在相邻锚点之间选0.5分，须在理由中说明支持与扣分；不能因为不确定就统一给5分。评分目标是证据判断，不要求数学式自动从一两个财务比率推导。

| 维度 | 0–2分 | 4分 | 6分 | 8分 | 10分 |
| --- | --- | --- | --- | --- | --- |
| 生意质量 | 客户价值/盈利模式已严重受损且有持续证据 | 产品可替代、议价或持续价值较弱 | 商业模式成立、客户价值稳定，优势尚一般 | 客户留存、切换成本或其他优势有跨期经营证据 | 多来源、跨周期验证优势持久，重要反证均已正面处理；极少使用 |
| 增长兑现 | 核心需求/每股经济收益持续恶化，计划明显失效 | 增长弱或主要靠并购、提价/会计变化，兑现不足 | 核心增长与计划基本兑现，现金转化可解释 | 有机增长、利润/现金及核心经营指标共同支持兑现 | 跨期持续兑现且单位经济改善，增长来源可验证；不能只用高同比 |
| 估值安全 | 在合理情景下价格明显缺乏支撑，或下行暴露很大 | 基准估值缺安全垫，价值依赖乐观假设 | 价格低于有依据的基准值，但压力情景仍有风险 | 明确折价、主要假设可验证，压力与敏感性后仍有较强支撑 | 多方法和压力检验均支持显著安全垫，重要索偿与资本需求齐备；极少使用 |
| 错杀催化 | 已确认永久损害，所谓错杀逻辑被反证 | 仅有跌幅/低倍数/叙事，缺少差异证据 | 有合理差异假设与可跟踪催化，但市场计价证据尚有限 | 有可验证预期/价格隐含假设差异，催化可衡量且有时间窗口 | 差异、未计价程度、兑现路径均由多条独立证据支持；不能将事件公布当未计价 |
| 财务韧性 | 持续经营、融资或资本结构存在重大已证风险 | 债务/再融资/资本投入压力明显，缓冲有限 | 现金、负债和投入基本匹配，风险有明确约束 | 压力情景下仍有融资/现金缓冲，稀释和承诺透明 | 跨周期压力能力强、资本配置与索偿充分验证；不能只用净现金高 |

最低材料要求：生意质量要读主营业务与风险原文；增长要有可比跨期数字及增长来源；财务韧性要有资产负债、现金流、债务/承诺材料。估值安全需要适用模型、有效参考报价及情景；错杀催化需要检查公开基线、差异假设、可衡量催化和反证。已完成检索但找不到独立共识时可以评为证据有限并说明，不能编造共识；连基本事件/价格归因都无法核对则未评估。

缺独立共识或可验证隐含预期时，错杀催化不能进入8–10分档。基准安全边际非正时，估值安全不能进入6–10分档。重大持续经营/索偿问题未解决时，不给财务韧性8–10分。分档不直接对应交易建议。

完整分数：`round(0.2*BQ + 0.2*GE + 0.3*VS + 0.2*MC + 0.1*FR, 1)`；任一维null则总分null，不给部分加权和，不重分配权重。所有分数越高越有利。

维度置信度：high=关键事实均有一手材料、跨期可比、重要矛盾已解释；medium=必要事实有依据，但前瞻假设或外部计价存在明显不确定性；low=重要来源/口径/覆盖缺口尚未解决。总置信度取五维最低档，存在未评估维度则为low；置信度不乘进评分，也不是成功概率。

结论枚举与顺序：

1. `not_supported`（不支持错杀）：已有充分证据显示长期核心逻辑失效；或有可比较的有效模型/报价且基准价值不高于参考价。注明适用范围，不强迫所有维度都齐全后才能陈述已知反证。
2. `supported`（有证据支持）：五维完整、总体置信度至少medium、基准安全边际为正、错杀催化至少8分、没有未处理的决定性反证，并给出兑现指标与失效条件。单靠总分或折价不满足条件。
3. 其他情况均 `pending`（待验证）。无模型或无报价不能判“有证据支持”。

`reportStatus` 与结论分开：必要五维/模型/参考价任一缺失为insufficient；全部齐备为ready。ready可以是pending或not_supported，表示研究流程完整，不代表看多。

**4. 数值输入与模型计算合同**

归一规则：金额使用估值币种的基础货币单位、股数使用基础股数，比例为0–1小数，增长率允许负数。持久化事实金额用十进制字符串并保留原scale；计算层统一转换，不在中间步骤按显示精度舍入。结果保留未舍入值，货币/每股显示两位小数，评分一位。

每个已披露值含原concept/context/期间/来源。每个derived值含有符号项和算式。每个assumption含理由和证据关联；计算器没有隐式增长率、折现率、终值增长、税率、稀释或正常化默认值。显式0必须有理由，missing不能变0。

事实选择：同公司、股类、口径和期间一致后，选择研究截止日前最新正式更正/重述的同一披露；完整已发布projection与原件冲突时回原件校验，不混取两个口径。原件的正式财务行优先于公司非GAAP指标，后者只有在选定对应非GAAP模型时使用。不可消除的关键冲突使相关模型insufficient。

CapEx统一为支出正值，在现金流公式中减去；从现金流表负号转成支出正值必须保存原符号与转换算式，不能对任意数值取绝对值。CFO、盈利、营运资本变动保留经济正负。股数要求>0，不接受对不同股类或期间随意替换。ADR换算必须有已验证比例；缺失则不计算该证券每股价值。

计算器支持下列方法类型，全部有bear/base/bull三情景；同一报告选一个主模型。主模型选择先由业务性质和输入可得性决定，再计算结果，禁止按“哪种估值更高”反选。交叉检验最多一个模型，独立列出，不静默平均。

| 模型类型 | 适用/必需输入 | 禁止或缺口 |
| --- | --- | --- |
| `fcff` | 非金融经营企业；EBIT、有效税率、D&A、完整CapEx、ΔNWC、明确SBC处理、股权桥接和稀释股数 | 资本/营运现金口径不明、金融集团资金性质不适用 |
| `fcfe` | 利息/税后CFO能够代表经营基础；CapEx、SBC、正常化与净借款假设、股数 | 不能把债务筹资当经营创造；不能重复加现金减债，重大非经营资产需明确处理 |
| `revenue_fcfe` | 收入基础和扣足经济成本的权益现金利润率路径；股数 | 不得用收入增长率替代现金利润率依据 |
| `residual_income` | 金融等更适合账面权益框架的公司；普通股账面、ROE与分配假设、股数 | 普通权益归属不明或非正，未处理优先股/NCI |
| `earnings_multiple` | 已核对同财年EPS指引区间及GAAP/非GAAP口径、研究倍数 | 不能当已实现TTM或独立共识 |
| `reported_earnings_multiple` | 完整TTM普通股经济盈利、匹配股数、研究倍数 | 负盈利不用正PE计算；一次性项需明确 |
| `proforma_earnings_multiple` | 公司已披露且能核验的完整年度Pro forma普通股盈利、股数 | 不能由单季年化冒充公司披露的Pro forma |
| `asset_nav` | 明确资产数量/价格/成本/税、非经营净资产、债务/优先索偿、运营储备与股数 | 资产权属、双重计入、无法估计的重大索偿 |
| `affo_multiple` | 公司AFFO定义、每股区间、经核验尚需扣除的经常成本、同口径股数/OP权益 | AFFO不能当GAAP EPS；已扣成本不重复扣 |
| `affo_dcf` | 完整年度AFFO、尚需扣除的经常成本、五年增长/折现、同口径股数 | 不对利息后权益现金再次扣净债 |

模型选择顺序：资产持有实体先检查NAV，REIT先检查AFFO，金融企业先检查剩余收益；其他经营企业优先使用能够形成有据经营现金流的FCFF，若只能可靠构造利息后股东现金则FCFE。收入驱动FCFE用于现有现金不代表稳定经营而收入/现金利润率路径有依据的情况。相应现金/账面模型不适用但同口径盈利可靠时用明确盈利基础的倍数模型；无法满足任何模型则模型为null、列明unsupported_model或missing_inputs。倍数估值本身仍需研究假设，不能自动抄同行中位数。

共同现金流计算核：预测5年、每年末折现、同一情景固定折现率r，明确终值增长g且r>g。`CF[t]=CF[t-1]*(1+growth[t])`；`TV=CF[5]*(1+g)/(r-g)`；`PV=sum(CF[t]/(1+r)^t,t=1..5)+TV/(1+r)^5`。输出逐年CF、终值现值、终值占比；不得把终值依赖隐藏。首版不做年中折现或财年stub，报告说明限制。

折现率必须带 `discountRateBasis`：FCFF固定为wacc；FCFE、收入FCFE、剩余收益、AFFO DCF固定为cost_of_equity；对未来每股权益价值折现的倍数模型也用cost_of_equity。每个情景记录r的依据或显式研究假设；不能将公司WACC直接用于股东现金流。NAV为研究时点资产净值，不加一层隐式折现。

- FCFF起点：`EBIT*(1-taxRate)+D&A-CapEx-ΔNWC+normalization-sbcAddbackRemoval`。EBIT本已包含SBC时无需再扣；只有D&A或其他加回实际包含SBC，才通过显式sbcAddbackRemoval扣回。股权价值=`PV+nonOperatingAssets-debtAndOtherClaims`，再除情景经济股数。桥接分别列明可归股东现金、受限资金排除、债务、租赁、优先股、NCI等，零项必须已核对，避免重复。
- FCFE起点：`CFO-CapEx-SBC+normalization+netBorrowing`，仅使用完整FY/TTM；股权价值为`PV+nonOperatingEquityAdjustment`，不重复扣已经由利息、净借款及预测偿付处理的债务。该adjustment只含未进入预测现金流/分配、已核验可归普通股的非经营净资产，须列明现金用途、税及索偿扣除；不能把全部账面现金直接加上，已计入预测的部分不再加。显式0要说明不存在、已包含或不重大；重大非经营资产无法合理处理则模型insufficient。正常化净借款可显式假设0，但不得称为披露事实。首版扣SBC作为经济成本；不再同时扣同一未来授予的完整稀释成本。已有未结算可转/索偿仍需独立识别。
- 收入FCFE：`Revenue[t]=Revenue[t-1]*(1+growth[t])`，`CF[t]=Revenue[t]*afterSbcEquityCashMargin[t]`；用共同折现核的逐年现金流版本，终期利润率需解释。不能套用先现金再增长的另一条公式。
- 剩余收益：起始普通权益B0；`E[t]=ROE[t]*B[t-1]`，`D[t]=payout[t]*E[t]`，`B[t]=B[t-1]+E[t]-D[t]`，`RI[t]=E[t]-r*B[t-1]`；第6年RI=`(terminalROE-r)*B[5]`，股权价值=`B0+sum(RI[t]/(1+r)^t)+RI[6]/(r-g)/(1+r)^5`。终期采用恒定ROE、账面权益与RI同速增长g的分支，`terminalPayout=1-g/terminalROE`，计算器校验并展示该隐含分配率。首版要求B0/B[5]>0、terminalROE>0、0<=g<=terminalROE、g<r；不满足则不套此终值分支。零超额收益时RI恒0。分配比率、ROE、终期ROE/g均显式。合并/NCI/优先权益及已知转股若不能清晰桥接则insufficient，不擅自忽略。
- EPS指引倍数：`EPS=(1-w)*epsLow+w*epsHigh`；价值=`EPS*multiple/(1+r)^horizonYears`。报告区分预测财年，horizonYears明确给定，不能隐式将未来价值当今日价值。
- 已报/Pro forma盈利倍数：`EPS=commonEarnings/economicShares`；价值=`EPS*earningsScale*multiple/(1+r)^horizonYears`。TTM、Pro forma和指引三种basis不得互换，earningsScale是显式研究假设。
- NAV：`assetValue=sum(assetUnits[i]*scenarioPrice[i])`；`tax=sum(max(assetUnits[i]*scenarioPrice[i]-costBasis[i],0)*taxRate[i])`；普通股净值=`assetValue-tax+otherNetAssets-debtClaims-preferredClaims-operatingReserve`；再除经济股数。资产税如需不同计税规则，首版不硬套此分支；标明不适用。
- AFFO倍数：`afterCostAffoPerShare=(1-w)*affoLow+w*affoHigh-recurringCostPerShare`，再乘倍数并按明确horizonYears/r折现。
- AFFO DCF：CF0=`annualAffo-recurringCost`，用共同现金流核，再除同口径经济股数；不重复扣净债。

各情景经济股数=`verifiedBaseShares+explicitDilutionReserve`，稀释储备可为显式0假设；涉及转股后的索偿减少/新增现金必须与股数同步、来源明确。无法核对的复杂资本条款进入缺口，不能用通用稀释率掩盖。

收入FCFE与AFFO DCF也使用相同的nonOperatingEquityAdjustment定义，不重复计入已包含的现金或债务。AFFO和盈利倍数若重大非经营资产未体现在所选每股基础/倍数且无法明确桥接，首版标记模型局限及insufficient，不默认其价值为0。

允许现金流、RI和普通股净值为负；保留负值，不静默截0。只有百分比比较因非正分母而不展示。输入非有限、r<=g、股数<=0、负倍数、缺少必要期间/口径则拒绝计算。三情景结果应bear<=base<=bull；不满足时退回修正假设，不能排序结果后冒充原情景。

**5. 工具合同与研究终止**

内部工具接受结构化参数，所有ID都来自本轮材料包或已登记返回值；下面合同由Zod实现，不能让模型提交任意SQL。检索输出是导航，只有读工具能登记可引用证据。

| 工具 | 输入 | 输出 |
| --- | --- | --- |
| `read_financials` | metrics[],periodType,periodCount,periodEnd? | facts[{id,value,unit,period,basis,formula,sourceRefs}],gaps[] |
| `list_filings` | forms[],limit | documents[{documentId,accession,form,filedAt,reportDate,status,url}] |
| `find_filing_sections` | question?,keywords?,canonical?,documentIds?,peers? | sections[{documentId,sectionId,path}],recallStatus |
| `read_filing_section` | documentId,sectionId?,focus[],maxChars | passages[{evidenceId,passageId,path,text,table?}],omitted |
| `read_earnings_material` / `read_transcript` | materialId/transcriptId,focus[],maxChars | dated excerpts[],evidenceIds[],coverage |
| `read_peers` | query?,metricKeys[] | comparisons[],basis[],gaps[]；不生成其他公司的任务 |
| `search_evidence` | gapId,question,query,dateRange?,domains? | hits[{hitId,url,title,snippet,publishedAt}],retrievalMeta |
| `read_web_evidence` | hitId或后端已核实sourceId,focus[] | evidenceId,excerpt,contentHash,publishedAt,fetchedAt,readAt,coverage |
| `calculate_valuation` | modelType,inputRefs,三情景显式假设 | calculationId,formulaVersion,results,issues[] |
| `compose_valuation` | dimensions[],verdict理由,calculationId?,reportSections,gaps[] | draftId,validationErrors[] |
| `finish_valuation` | draftId | ready/insufficient草稿；错误未解决不能接受ready |

首次完整评估最多16轮模型交互、12次SEC/材料正文读、6次库内检索、4次Web搜索、6次Web正文读；增量评估最多10轮、8/4/2/3次。一次正文读默认12000字符，单份材料总读取预算由现有上下文裁剪策略限制。预算是上限，不是目标；Web缓存复用依旧算本轮工具调用，实际费用另记。

仅在基础材料或方法发生变化时运行增量评估；显式管理员重评属于一次新初评预算。工具预算用尽时允许用已取得证据完成，必要证据仍缺则insufficient。最多两次输出修复机会，schema/引用持续不合法则本次失败；不无限让模型修复。研究截止时间固定，运行耗时使用真实计时，不能复制固定host.now来衡量墙钟预算。

提示词必须包含：五维问题和锚点、已选模型适用条件、所有事实来自登记证据、搜索摘要不算读过正文、反证优先处理、假设不能当披露、禁止直接编最终估值、必须给出下一验证点和失效条件。无需原站提示词即可执行。

**6. API 与网页状态合同**

Analysis 路径前缀 `/api/v1/companies/:ticker/valuation`，业务地图同源代理为 `/api/business/v1/companies/:ticker/valuation`。沿用现有 errorResponse/dataResponse 与鉴权，不增加浏览器付费搜索接口。

| 方法/后缀 | 返回 |
| --- | --- |
| GET 空后缀 | `ValuationResponse`，当前报告与最近尝试 |
| GET `/versions?before=<versionId>&limit=20` | `{items:[{versionId,generatedAt,researchAsOf,status,weightedScore,verdict}],nextCursor}`；最大50 |
| GET `/versions/:versionId` | `{report:ValuationPublication}`，验证该版本属于此ticker |
| GET `/versions/:versionId/evidence/:evidenceId` | `{evidence:EvidenceSnapshot}`；验证版本归属和版本—证据关联 |

关闭公司/功能：当前接口200返回availability=hidden，report/latestAttempt均null；历史与证据接口404，避免旧链接绕过。无报告但功能开：200、preparing；初次材料不足：200、insufficient；查询不存在的版本/证据404；无DB/依赖存储不可用503；非法参数400；非GET/HEAD读请求405。授权与开关检查在304之前。前端不从版本是否存在猜可见性。

```ts
type ValuationResponse = {
  schemaVersion: 'valuation-response.v1'; ticker: string;
  availability: 'hidden'|'preparing'|'ready'|'insufficient'|'failed';
  report: ValuationPublication|null;
  latestAttempt: null|{
    runId: string; status: 'queued'|'running'|'waiting'|'succeeded'|'empty'|'superseded'|'cancelled'|'failed';
    stage: string|null; updatedAt: string; reportStatus: 'ready'|'insufficient'|null;
    gaps: Gap[]; errorCode: string|null;
  };
  outdated: boolean;
};
```

`Gap={code,field?,period?,message,evidenceIds[]}`；code最少覆盖missing_inputs、unsupported_model、missing_quote、stale_quote、identity_mismatch、conflicting_sources、unverified_consensus、unreadable_source、research_budget_exhausted。没有使用到的某类材料不自动成为阻断缺口，按实际模型与维度要求判定。

Admin 单公司开关继续用现有 `POST /admin/business-map/companies/:ticker/features/valuation {on:boolean}`。新增 `POST /admin/business-map/companies/:ticker/valuation/reassess {requestId:UUID}`：仅对双开关开启且全局未暂停公司接受，其他返回409且不改变开关；保存幂等回执，202返回`{requestId,runId,status:'queued',reused:boolean}`。同一requestId重试复用原请求；新的requestId表示明确允许以同一基础材料重新研究、刷新Web和报价。复用现有sec_cache回执命名空间，不为重试自动打开开关。

当前响应在Admin操作和任务状态变化时刷新；页面在估值显示期间沿现有revisions机制获知变化，不在浏览器直轮询外部行情。hidden在客户端切回可用财务页签。读取正文/版本/引用不触发任务。

**7. 持久化、发布与失败行为**

下表是新增表的最小字段合同；迁移文件取开发分支下一空序号，不硬编码历史序号。payload_json包含完整已验证合同，避免拆表重建报告时丢失冻结值。

| 表 | 主键/字段/索引 |
| --- | --- |
| valuation_versions | version_id PK；ticker、cik、generated_at、research_as_of、report_status、method_version、calculator_version、base_input_fingerprint、evidence_set_hash、payload_json；索引(ticker,generated_at DESC,version_id) |
| valuation_current | ticker PK；version_id nullable FK、latest_attempt_json、request_generation整数、updated_at；保存最新尝试摘要不依赖会清理的AiRun日志 |
| valuation_evidence | evidence_id PK；source_kind、source_url、document_id/passage_id nullable、source_sha256、passage_text_sha256、content_sha256、object_key nullable、payload_json；payload保留日期、引用、定位、获取/读取时间 |
| valuation_version_evidence | (version_id,evidence_id)复合PK/FK；按evidence_id索引用于保留和引用检查 |

versionId为排序键稳定的规范化报告内容hash，排除runId/生成时间；材料指纹和方法/公式版本、冻结报价、模型/分数/文本/证据集均参与。仅时间戳不同不新增版本。evidenceId由来源身份+实际内容hash生成，正文不覆盖旧内容。证券身份属于版本；相同来源内容可以被多个版本引用，读API通过版本绑定鉴权。

request_generation在新输入调度、显式重评、公司/功能开关变更时推进，用于拒绝过期运行。全局暂停也使在途运行失去发布资格。实现使用现有公司设置更新和估值状态的D1事务接线；不得只把启动时env当作永久授权。

R2正文证据先写成功；同一D1 batch写不可变版本、证据关联、带generation条件的当前指针更新和outbox事件。未赢得条件更新的运行标记superseded，不发送成功发布事件。发布前重新读实际材料版本与当前资格；如材料已经更新，安排合并后的下一次运行。后到事件也会将旧报告标为outdated并补跑。

current规则：ready结果成为当前版本；首个insufficient也保存为版本并作为当前缺口报告；已有ready时，新insufficient只进入历史与latestAttempt，保留原current并outdated=true。运行技术失败不产生报告版本、不覆盖current。读接口availability以可显示报告状态优先，旧ready+新失败仍返回ready并带latestAttempt.failed/outdated。

运行状态：ready发布映射succeeded；insufficient映射empty，result.reportStatus明确为insufficient；关闭映射cancelled；旧输入/旧generation映射superseded。以上均不触发功能失败停用。服务瞬时错误在本次Workflow允许的有限重试内处理；耗尽或最终技术错误为failed，沿用现有Admin行为：generate置0、display保留、通知管理员，手动重新开启才恢复。不要将“缺材料”抛成技术失败。失败处理同样检查generation，旧运行不能停掉用户刚重新开启的功能。

现有 `recordFeatureFailure` / `driveWorkflow` 会停generate，这一行为必须接入并在Admin显示「已停止生成」，不能出现开关仍表示运行但事件再也不触发。全局暂停、手动关闭和失败停生成有不同展示语义。

报告和证据版本不受AiRunStore最近20次运行/30个版本清理影响。首版长期保存报告和实际使用的引用快照；不承诺整份旧SEC原件永久可重读。若要提供完整旧原件回放，另把valuation引用加入archive-prune保留集合。网页持久证据不放web-search短期缓存前缀。

**8. 事件、指纹与并发**

估值任务scope为valuation，但统一资格函数必须额外与data相交。采用5分钟debounce、首事件起最多30分钟等待；这是合并同份财报多条事件的首版调度参数，不新增Cron。单公司最多一个运行；运行期间新事件记为pending，结束后处理最新输入，不逐事件堆报告。

| 事件 | 动作 |
| --- | --- |
| feature.settings，feature=valuation | 开启时检查/调度；关闭时取消资格并刷新展示 |
| 公司重新开启，且存储的valuation仍开 | 用最新材料检查；不能只给全新公司发初评事件 |
| financials.published、map.derived、fundamentals.updated | 比较相关已验证数值/来源版本 |
| library.prepared、guidance.published、transcript.stored | 比较本公司可用原文/材料集合；不是只看filing.discovered |
| valuation任务方法版本变化 | 只对双开关公司按新方法检查 |
| 管理员reassess | 使用requestId，允许同输入重评 |
| valuation.published | 刷新valuation资源、Admin结果、翻译；不能触发valuation自身形成循环 |

基础指纹纳入：证券身份、方法/公式版本、参与研究的已发布财务数值及lineage、已选文件的document/source/parser版本、相关指引内容hash、ready电话会内容hash、已选同行资料版本。排除updatedAt/fetchedAt/readAt等纯时间戳、当前runId、当轮新Web证据和纯价格。方法注册自己的版本常量，不能借analyst版本。

首版new/增量材料范围固定：最新完整年度及可比前年度、可用近8季、最新季度/中期、最新财务期末之后到researchAsOf的重大公告、有关债务/资本/业务原文。集合中缺哪一项按研究问题记录；新文件、重述或原文hash变化要改变指纹，不只按periodEnd去重。

现有ToolPolicy.pre为同步，runTool可能把执行异常转换为观察。开关检查放在估值LoopHost的异步reserve/execute外层，取消直接结束loop；不能只在工具里throw然后让模型继续。已开始逻辑步骤内的SDK重试/回退可能完成，但不启动下一步。

**9. 无截图也可实现的页面规格与语言**

定位 `BusinessMap.tsx` 的 `#company-stage`：估值作为公司主内容模式，占用当前财务主图、事件时间轴、趋势面板和图例的合并区域。公司搜索/身份/主导航共享。入口与利润/现金流/资产负债表同级，不能被“是否有资金图/现金流数据”的条件一起隐藏；只受valuation展示开关控制。

主页面容器也不能因财务flow尚未完整就挡住已启用估值的公司。若缺业务拆分但已有可用集团财务/研究，应可进入估值页签；财务页签显示其原有未就绪状态。只调整已开启公司的容器与资源加载条件，不扩大搜索名单，不为未开启公司建立入口。

点击估值时关闭/退出当前事件、SEC报告、要点lens等覆盖该区域的详情；Stage对话侧栏沿现有开关使用，但首版不把financial工具假装支持valuation（切换时清理错误的财务选中上下文）。点击这些财务详情时退出估值模式并恢复其正常优先级。保留财务状态，返回时恢复财季、业务、趋势选择。

静态布局：

```text
公司名称 / 股票身份                 利润 | 现金流 | 资产负债表 | 估值评估
───────────────────────────────────────────────────────────────────
结论、综合分/未完成、置信度       研究日期 / 财务基期 / 版本选择
五维雷达图                       五项分数、权重、逐项判断入口
三情景价值表                     参考收盘价（日期）、安全边际
模型方法、输入、假设、敏感性与局限（展开）
生意质量 / 增长兑现 / 财务韧性 / 预期差与催化 / 反证与下一验证点
来源列表（点击看本版引用快照与原文链接）
```

六个必要页面状态：首次排队/运行、首次insufficient、ready、旧ready+更新中、旧ready+更新失败/缺口、历史版本。完整雷达需要五维齐全；缺分时显示文字分项与缺口，不用零分补多边形。历史版正文/模型/引用/参考价全部绑定所选versionId。来源抽屉可滚动，桌面侧栏、窄屏全宽；无连续嵌套横向滚动。

沿用现有中英文体系：UI文案走项目i18n；报告先产出受验证的标准原稿，再走已有翻译链路，不在浏览器实时调用模型。valuation注册独立翻译资源，scope包含versionId；日期、数字、公式、ID、SEC/网页原句不翻译，解释可翻译。翻译未就绪时显示原稿并标注语言，不谎称中文内容已齐备；翻译状态不改变财务模型和ready。验收中文界面及至少一份完成翻译的报告。

**10. 必改接线清单**

| 工作包 | 文件/接入点 |
| --- | --- |
| 合同和计算 | 新增shared/analysis-contract/valuation.ts、shared/analysis-runtime/valuation/；强类型数据、Zod解析、公式和评分合成 |
| 资料/证据/研究 | 新增workers/analysis/src/valuation/{input,policy,recipe,tools,evidence,store,workflow}.ts；复用主方案的现有读取入口 |
| Workflow三件套 | index.ts导出ValuationWorkflow；operations.ts增加VALUATION_WORKFLOW；wrangler.jsonc注册name=spontra-valuation、binding、class_name |
| 功能开关 | business-features.ts、company-policy.ts、admin/feature-settings.ts；默认名单空、统一data交集 |
| 模型设置 | ai-config.ts注册valuation（reasoning模型/high作为默认）；沿用Admin模型配置，不硬编码账户具体模型 |
| 数据库 | 下一序号迁移扩功能CHECK及新表/索引，Drizzle schema同步，保留旧行；不回填开启 |
| 任务 | pipeline/registry.ts、ai-tasks.ts/tasks.ts、workflow-task.ts相应联合类型/实例ID/指纹；定义订阅及无自触发循环 |
| 运行和消息 | ai-runs-admin.ts、tracking/store、admin/ai-runs.ts、admin/messages.ts；补kind/task/feature/status/发布与失败映射 |
| Admin网页 | business-map-companies、admin-messages、ai-runs、run-progress、business-view-admin；开关、状态、步骤、资料/费用与重评 |
| API和刷新 | read-api/router.ts、业务地图worker代理、revisions合同、pipeline/revisions.ts、company-data.ts/live-company.ts；开关变化也刷新 |
| 网页和翻译 | BusinessMap和独立ValuationPanel/ScoreRadar/Model/Source组件；i18n；translation runtime/worker/admin注册版本级资源 |
| 验证与部署 | 下列合成数值、关键状态验收；项目既有boundary/typecheck/build；双Cloudflare构建分别核验 |

不要直接导入仓库外Mispriced文件，不访问其API，不要求其credentials，不重新搭搜索服务。现有 `docs/web-search.md` 的旧供应商例子随实现修正。新增文件组织可微调，产品合同和结果语义不可悄悄改变。

**11. 可重复的验收样本与完成门槛**

以下是合成公式样本，与任何真实股票无关，金额和股数均为基础单位；不用于校准评分。

| 样本 | 输入 | 必须输出 |
| --- | --- | --- |
| FCFE常量 | CFO150、CapEx20、SBC30、normalization0、netBorrowing0、nonOperatingEquityAdjustment0；5年growth全0；r=0.10、g=0、shares100 | CF0/每年CF=100；股权价值1000；每股10 |
| FCFF桥接 | 5年CF均100，r=0.10、g=0；nonOperatingAssets200、claims300、shares100 | 经营价值1000、股权900、每股9 |
| 剩余收益零超额 | B0=1000，5年ROE=r=0.10，payout全1，terminalROE=0.10，g=0，shares100 | 所有RI及终值RI=0、股权1000、每股10 |
| 剩余收益非零超额 | B0=1000，5年ROE=0.12、r=0.10、payout全0.5；terminalROE=0.12、g=0.03、shares100 | terminalPayout=0.75、股权约1321.94、每股约13.2194 |
| EPS倍数 | EPS2、multiple15、r=0.10、horizon0 | 每股30 |
| NAV | 10单位资产×100、税0、otherNetAssets50、debt200、preferred100、reserve50、shares100 | 普通净值700、每股7 |
| 五维合成 | BQ8、GE7、VS6、MC5、FR9 | 总分6.7；任一项null则null |
| 安全边际 | 参考价80、基准值100 | 安全边际20%，基准空间25%，两者不得互换 |
| 公式拒绝 | r<=g或shares<=0 | 明确计算错误，不产生NaN/Infinity或伪造金额 |

另外对收入FCFE、三种盈利basis、AFFO倍数与AFFO DCF各做一个可手算样本，并验证负现金流/负股权保留、scenario顺序、衍生输入算式和股数口径；无需大量镜像实现的单测。

必须通过的集成场景：默认关闭零任务；双开关后真实材料→报告；任务中途关开关；旧run失败不能停掉重新开启的新run；新材料到达时合并补跑；同requestId不重复、不同requestId可强制复评；insufficient与技术失败不同；旧报告保留；证据缓存清理后历史引用仍可读；关闭后API与页签隐藏；中文/窄屏/返回三大表状态正确。

本地基础检查：`npm run check:analysis:boundary`、`npm run analysis:typecheck`、`npm run business-site:typecheck`、`npm run admin:typecheck`、`npm run build`。相关项目检查与测试按实际变更运行；`analysis:check`涉及Wrangler打包预检，先核对仓库允许的命令，不执行真实本地部署。结构迁移必须在本地SQLite和CI既有迁移流程验证，生产只由main自动构建应用。

最终验收需要在用户授权的已开启公司上启用估值并实跑，检查SEC引用、真实Web读取/费用、模型与界面结果、关开关行为。只通过mock不能宣称已可线上研究。若凭据或来源缺失，明确列环境/材料阻碍，不以合成数据填生产。不同LLM可能给出不同定性分数，因此验收依据是评分规范和证据，而非与某次模型结果逐字相同。

**12. 可直接给下一位 Agent 的任务说明**

> 在 Spontra 仓库实施 docs/valuation-assessment-design.md 与 docs/valuation-assessment-implementation.md。先核对当前AGENTS和源码变化；本次前端按用户明确选择放apps/business-site，新增Admin逐公司估值开关，默认全关。只对公司与估值双开关允许的公司运行。复用现有SEC原文/财务/电话会/同行及Web Search，按本规格重新生成评估，不需要访问Mispriced。先完成合同、计算器、开关与单公司资料链路，再接完整Workflow和网页；按样本与关键状态验收。不要以静态报告或人工评分代替实现，不自动打开生产公司开关。提交/上线遵循当次用户授权与AGENTS，仅在要求上线时推main并核验两个自动构建。
