# G6 / G8 价格影响与个人假设敏感性

本记录是本地合成数据验收，不等于真实金融来源审核或生产上线验收。没有调用付费模型，没有生产写入。

## 已实现

- `shared/analysis-runtime/price-impact.ts`：有界输入计算、缺失与零区分、冻结报价、事件增量/估值空间/行情变化分离、失败情景不归一化。
- 财报与估值页读取同一版本价格影响投影；历史 URL 固定版本与原始报价。没有匹配前后事件模型时明确不可归因。
- `shared/analysis-runtime/valuation/adjustment.ts` 复用现有 `scenarioValue`，必须复现原报告现金流方法基线。读者只可修改一个年度收入增长率、营业利润率或折现率，范围 ±10 个百分点。固定票息不随折现率变化。
- `0061_user_valuation_adjustments.sql` 独立保存个人不可变结果；POST/GET 沿用签名读者、同源入口、估值展示权限、配额（不依赖付费 Stage 开关）；不覆盖已发布研究。相同输入复用同一保存结果。
- 固定侧栏提供“假设敏感性”；报告摘要和估值页按 URL 的同一个 `valuationAdjustment` ID 读取。结果明确标为个人现金流敏感性，不冒充新研究、完整混合估值或已发生事件。
- 估值采用公共研究时，发布验证版本、claim、shock、公司证据；同一冲击与财务变量禁止重复采用。原子依赖记录和读取时检查使过期/失效研究暂停量化展示，包含历史版本与个人敏感性。

## 执行与证据

1. `node --experimental-strip-types scripts/price-impact-acceptance.ts`：计算与真实工具接口旅程，19 项通过。输出 `/tmp/spontra-price-impact-acceptance.json`。
2. `node --experimental-strip-types scripts/valuation-adjustment-acceptance.ts`：使用 SQLite 和实际存储/计算函数，15 项通过：保存、重读、去重、读者隔离、三个控制变量、零/越界/NaN 拒绝、基线不一致拒绝、依赖失效阻止新建和旧结果读取、原始报告不变、隐藏公司不可读。输出 `/tmp/spontra-adjustment-acceptance.json`。
3. Chromium 本地真实点击/填写/保存/刷新/历史链接跳转，保存结果 ID 一致，无 pageerror。浏览器网络回放第 2 项的真实 SQLite 输出，并非生产 API 验收。脚本 `/tmp/spontra-adjustment-browser.mjs`，输出 `/tmp/spontra-adjustment-browser.json`，截图 `/tmp/spontra-adjustment-ui.png`（已检查像素）。
4. 原价格影响界面：390×844、768×1024、1440×900，中英文、冻结/更新行情、历史版、PageDown、滚轮到底和返回、无横向溢出、无 pageerror。输出 `/tmp/spontra-impact-ui/results.json`。
5. 改动范围 ESLint、business-site 与 analysis 类型检查通过；集成后的完整构建由主任务统一执行。

## 明确边界

- 没有真实受控事件前后模型的报告，事件增量仍为不可量化；个人假设敏感性不填充该字段。
- 个人敏感性仅复用现金流方法，不重造无法从旧报告恢复的同行倍数/混合权重上下文。
- 部署时须应用 migration 0061；生产需实测读者签名、开关、保存/刷新、跨页 ID 和失效依赖阻断。尚未执行生产验收。
