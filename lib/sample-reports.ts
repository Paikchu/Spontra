/* Sample Agent reports. Shown with a "示例" label until the real report feed exists. */

export type DailyReport = {
  id: string;
  title: string;
  subject: string;
  agent: string;
  time: string;
  fact: string;
  judgment: string;
  impact: string;
  next: string;
  sources: string;
  /** Evidence state of the headline fact, shown on the Today page. */
  evidence: "support" | "counter" | "pending";
  followUps: { agent: string; time: string; text: string }[];
};

export const sampleReports: DailyReport[] = [
  {
    id: "project-timing",
    evidence: "counter",
    title: "项目延期",
    subject: "持有理由",
    agent: "研究 Agent",
    time: "09:10",
    fact: "项目交付时间后移，订单状态尚未披露。",
    judgment: "按期交付的前提已变化；目前不足以判断需求转弱。",
    impact: "两项持仓的增长判断都引用了该项目时间表。",
    next: "核对客户后续披露；若订单变化，再更新持有理由。",
    sources: "公告原文 · 投资记录",
    followUps: [
      { agent: "核验 Agent", time: "09:11", text: "公告没有披露订单取消。订单状态仍待确认。" },
      { agent: "风险 Agent", time: "09:12", text: "两项持仓的共同前提已列入跟踪。" },
    ],
  },
  {
    id: "customer-adoption",
    evidence: "support",
    title: "客户采用",
    subject: "新进展",
    agent: "研究 Agent",
    time: "08:42",
    fact: "客户公开确认产品已投入使用。",
    judgment: "采用得到新证据，收入贡献仍无法确认。",
    impact: "持有记录中的采用假设获得支持，收入预测暂不调整。",
    next: "等待合同规模或续约信息，再复核商业化判断。",
    sources: "客户披露 · 投资记录",
    followUps: [
      { agent: "核验 Agent", time: "08:44", text: "客户原文没有披露合同规模。" },
    ],
  },
  {
    id: "shared-exposure",
    evidence: "pending",
    title: "共同敞口",
    subject: "组合关系",
    agent: "风险 Agent",
    time: "08:18",
    fact: "两项持仓的增长判断都引用同一项目进度。",
    judgment: "分属不同持仓的判断存在共同前提。",
    impact: "若项目继续延期，两项持有理由可能同时需要复核。",
    next: "将项目进度列入组合跟踪。",
    sources: "投资记录 · 项目公告",
    followUps: [
      { agent: "研究 Agent", time: "08:21", text: "合作关系已有依据，收入关联仍待核实。" },
    ],
  },
  {
    id: "pricing-check",
    evidence: "support",
    title: "价格疑点",
    subject: "复核结果",
    agent: "核验 Agent",
    time: "07:56",
    fact: "记录中的低价来自旧型号促销，新型号官方标价未变。",
    judgment: "现有证据不支持主力产品降价。",
    impact: "上次标记的定价疑点可以降级，后续报价仍需观察。",
    next: "继续比对新型号官方价格与渠道价格。",
    sources: "价格记录 · 官方标价",
    followUps: [
      { agent: "研究 Agent", time: "07:58", text: "原疑点和本次复核结论均已保留。" },
    ],
  },
];
