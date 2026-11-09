# Agent SDK + Pi Harness 迁移：未完成项

对应 issue #194。代码迁移已在 2026-11-08 上线：Workflows 已移除，任务运行在 `TaskRunner`，所有多轮 Agent 运行在 `PiHost`。

## 迁移收尾

- [x] 1. 上线 Agent tracing 和 Pi 层通用修复：工具结果截断要告知模型、单次会话 token 上限、看门狗唤醒、检查会话不无限等待、大结果存 R2、每轮记录、压缩记录。
- [ ] 2. 用 CRWV 各跑一次，验证线上行为（截至 2026-11-08 只有 SEC 报告在线上跑过，而且失败）：
  - [ ] 地图问答
  - [ ] 逐文件分析
  - [ ] 估值
  - [ ] 三表分析
  - [ ] 分析师
  - [ ] 业务脑图
  - [ ] 公司业务研究
- [ ] 3. 在 Cloudflare Agents 页确认能看到 trace。采样率 5%，单次运行只会显示部分轮次。
- [ ] 4. 把 read-note（`pipeline/financial-tasks.ts`）和报表判定（`pipeline/presentation-task.ts`）移进 `TaskRunner`。
- [ ] 5. 决定约 13 个模块的单次模型调用是否也走 Pi（要点、翻译、业务标签、业务解读、公司记忆、文件库卡片和关联、各 Agent 的事后审查等）。
- [ ] 6. 把压缩调用的 token 记入 `ai_usage`。目前 SDK 没有直接暴露，只记录了压缩次数。
- [ ] 7. 工具结果超限改成明确报错，上限按上下文窗口比例计算，并用真实大小的数据测试每个工具。
- [x] 8. 运行卡住：调用被平台取消后 `finally` 不执行，`busySince` 留下，唯一待触发的唤醒被提前消耗后再无唤醒。已修复（`durable-runs/wakes.ts`、`pi/within.ts`、`status()` 自愈），待线上验证。
- [ ] 9. 清理 `host.ts` 的 4 个 `no-explicit-any`，以及迁移留下的未使用导入。
- [ ] 10. 决定未跟踪的 `spikes/`（579 MB）是否删除。

## SEC 分析（单独 session）

- [ ] 11. 上线前先处理风险：线上 `sec/report-agent.ts` 没有 token 上限，可能空烧 token；可用后台“定时分析”开关先挡住定时运行。
- [ ] 12. 接手 worktree `issue-194-migration-plan-a17234` 里未提交的 SEC 改动：`sec/report-agent.ts`、`sec/reader.ts`、对应测试，以及后台“过程”查看（`admin/reports.ts`、`report-admin-proxy.ts`、`company-reports.tsx`、`admin.ts`）。
- [x] 13. （已被单会话版本取代，见 [filing-analysis-design](filing-analysis-design.md) 第 15 节）数据来源改成文件库：章节树、段落、结构化表格分开读取。
- [x] 14. （已被单会话版本取代）改成代码逐节分析，AI 不选章节；按 `previous_section_id` 滚动结合上一期分析，未变化的章节沿用。
- [ ] 15. 补上读取过往财报原文和网络搜索的能力。
- [ ] 16. 用 NET 2026 Q3 验证，并记录 token 总消耗。
