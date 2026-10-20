# 前端国际化约定（本期：界面与数字）

设计见 [i18n-design.md](i18n-design.md)。本文是写代码时的规则与术语表。

## 机制

- 页面语言：`packages/web/src/i18n/index.ts`。`getLocale()` 读当前语言，`useLocale()` 订阅，`setLocale()` 切换。切换时 `main.tsx` 以 `key={locale}` 重挂整棵树，所以任何文字或数字在渲染时按当前语言产出即可，不需要把 locale 一层层往下传。
- 文案：每个文件在顶部用 `messages(en, zh)` 定义自己的表；有限集合（事件类别、要点类别、报表视图）用 `labels(en, zh)`。`zh` 缺键或函数签名不同会在 `typecheck` 报错。
  ```ts
  const m = messages({ loadFailed: "Load failed", severity: (n: number) => `Severity ${n}` },
                     { loadFailed: "加载失败",    severity: (n: number) => `重要度 ${n}` });
  ```
- 数字：`shared/analysis-runtime/locale.ts` 里的纯函数（`compactMoney`、`compactShares`、`points`、`multiple`、`fiscalYearTo`、`yoyLabel`…），每个都显式接收 `locale`，默认 `"en"`。站点代码传 `getLocale()`。
- `shared/analysis-runtime/*` 同时被 Spontra Analysis Worker 使用：只能加**可选的、默认 `"en"` 的** `locale` 参数，Worker 的输出必须逐字不变；不得在 shared 代码里读全局语言。
- AI 生成的正文（要点标题与判断、报告 headline/bullets、事件摘要、业务树节点名、lens 的 prose/标题/标注）本期保持英文：所在元素加 `lang="en"`，在该内容块的标题处放 `<SourceLanguage />`（中文界面下显示「英文原文」，英文界面下不渲染）。
- SEC 披露的名称（业务分部名、公司名、表单号 10-K/8-K/Form 4、人名）不翻译。
- 文案只翻标签，不新增解说或旁白（见 memory「Frontend has no narration」）。

## 数字形式

| 内容 | en | zh-CN |
|---|---|---|
| 金额 | `$75.7B`、`−$28.7B`、`$350M` | `757亿美元`、`−287亿美元`、`3.50亿美元` |
| 股数 | `1.23M shares` | `123万股` |
| 百分比 | `12.3%` | `12.3%` |
| 百分点 | `+1.5 pp` | `+1.5个百分点` |
| 倍数 | `2.60×` | `2.60倍` |
| 每股 | `$1.24` | `1.24美元` |
| 财年区间 | `FY to 2026.08` | `截至 2026.08 财年` |
| 季度 | `2026.08` | `2026.08` |
| 日期 | `2026-10-13` | `2026-10-13` |

## 术语表

| English | 中文 |
|---|---|
| Findings | 要点 |
| Risk / Strength / Shift / Watch | 风险 / 优势 / 变化 / 跟踪 |
| Severity | 重要度 |
| Watch outcome | 跟踪结果 |
| Walk through | 逐条浏览 |
| Revenue | 营收 |
| Business revenue | 业务营收 |
| Cost of revenue | 营业成本 |
| Gross profit / Gross margin | 毛利 / 毛利率 |
| Operating expenses | 营业费用 |
| Research and development | 研发费用 |
| Sales and marketing | 销售及市场费用 |
| General and administrative | 管理费用 |
| Operating income / Operating margin | 营业利润 / 营业利润率 |
| Non-operating income (expense) / Other income | 营业外收支 / 其他收益 |
| Pretax income | 税前利润 |
| Income tax | 所得税 |
| Net income / Net margin | 净利润 / 净利率 |
| Eliminations | 抵销 |
| Profit (statement view) | 利润 |
| Cash flow | 现金流 |
| Balance sheet | 资产负债表 |
| Operating cash flow | 经营现金流 |
| Capex | 资本开支 |
| Free cash flow | 自由现金流 |
| Buybacks / Dividends | 回购 / 分红 |
| Debt issued / Debt repaid | 新增借款 / 偿还债务 |
| Equity issued | 股权融资 |
| Cash | 现金 |
| Total assets / Equity / Debt | 总资产 / 股东权益 / 债务 |
| Retained earnings | 留存收益 |
| Intangibles / Receivables / Inventory | 无形资产 / 应收账款 / 存货 |
| Guidance | 业绩指引 |
| Raised / Lowered / Reaffirmed / Narrowed / Widened / Initiated | 上调 / 下调 / 重申 / 收窄 / 放宽 / 首次给出 |
| Above / Within / Below (guidance) | 高于 / 处于 / 低于 指引 |
| Constant currency | 固定汇率 |
| GAAP / Non-GAAP | GAAP / Non-GAAP |
| YoY / QoQ | 同比 / 环比 |
| Quarter / Fiscal year | 季度 / 财年 |
| Report | 财报 |
| Filing | 文件 |
| Exhibits | 附件 |
| Events | 事件 |
| Earnings | 业绩 |
| Leadership change | 管理层变动 |
| Insider trade | 内部人交易 |
| Deal | 并购交易 |
| Financing | 融资 |
| Buybacks & dividends | 回购与分红 |
| Shareholder vote | 股东投票 |
| Legal & regulatory | 法律与监管 |
| Other | 其他 |
| Sale / Purchase / Exercise | 卖出 / 买入 / 行权 |
| 10b5-1 plan | 10b5-1 交易计划 |
| Analyst view | 分析观点 |
| Basis | 口径 |
| Not disclosed | 未披露 |
| Loading / Load failed / Retry | 加载中 / 加载失败 / 重试 |
| Show all | 显示全部 |
| Close | 关闭 |
| Search companies / Ticker | 搜索公司 / 股票代码 |
| Recently viewed | 最近查看 |
| Revenue model | 收入模式 |
| Subscription / Usage-based / License / Transaction fees / Advertising / Hardware sales / Service fees | 订阅 / 按用量计费 / 授权许可 / 交易费 / 广告 / 硬件销售 / 服务费 |

## 自动检查（离线）

`npm run check:i18n`，`npm run build` 第一步就会执行，自动部署时任何翻译问题都会让构建失败。全程不联网、不调用 API 或翻译服务，约 2 秒。实现在 `scripts/check-i18n.ts`。

| 检查 | 内容 |
|---|---|
| 文案表 | 通过 Vite SSR 加载所有 `messages()`/`labels()` 表：中文存在、确实翻译、插值参数与英文一致、术语表关键词、中文分隔符用全角 |
| 中文字面量 | 站点、`packages/web`、`shared` 中所有含中文的字符串：无残留英文单词、无半角标点贴中文、中英文之间有空格、无感叹号；CSS `content:` 不得含文字 |
| 数字形式 | 金额、股数、百分点、倍数、财年、区间在两种语言下的固定输出 |
| 渲染页面 | 用 `scripts/i18n/fixture.ts` 的虚构公司渲染首页、公司页、每条要点/事件/财报的 lens，以及每张 lens 图的 SVG：中文页面上 `lang="en"` 之外不得出现英文单词（数据除外）；英文页面不得出现中文 |

确有理由保留英文的中文字面量（引用文件里的分部名），在上一行写 `// i18n-allow: <原因>`。英文本身就是行业通用缩写的，加入脚本里的 `LATIN_TERMS`。

## 离线预览

```bash
BUSINESS_SITE_FIXTURES=1 npm run dev
```

打开 `http://127.0.0.1:4188/companies/ACME?lang=zh-CN`。开发服务器用同一份 fixture 充当读 API，不需要网络。
