"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useLanguage } from "./language-provider";

type DailyReport = {
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
  followUps: { agent: string; time: string; text: string }[];
};

const reports: DailyReport[] = [
  {
    id: "project-timing",
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

export function DailyReportsHome() {
  const { t } = useLanguage();
  const [selectedId, setSelectedId] = useState(reports[0].id);
  const [readIds, setReadIds] = useState<string[]>([reports[0].id]);
  const [replies, setReplies] = useState<Record<string, string[]>>({});
  const [draft, setDraft] = useState("");
  const selected = reports.find((report) => report.id === selectedId) ?? reports[0];
  const unreadCount = reports.length - readIds.length;

  function openReport(id: string) {
    setSelectedId(id);
    setReadIds((current) => current.includes(id) ? current : [...current, id]);
  }

  function sendReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setReplies((current) => ({
      ...current,
      [selected.id]: [...(current[selected.id] ?? []), text],
    }));
    setDraft("");
  }

  return (
    <section className="daily-reports" aria-labelledby="daily-reports-title">
      <div className="daily-reports-layout">
        <div className="daily-reports-conversation">
          <header className="daily-reports-heading">
            <div>
              <h1 id="daily-reports-title">{t("群聊")}</h1>
              <p>{t("研究")} · {t("核验")} · {t("风险")}</p>
            </div>
            <Link href="/">{t("投资账本")}</Link>
          </header>

          <div className="daily-reports-thread" aria-label={t("汇报对话")}>
            <div className="daily-reports-byline"><strong>{selected.agent}</strong><time>{selected.time}</time></div>
            <article className="daily-report-document" aria-labelledby="daily-report-title">
              <p className="daily-report-kicker">{t("示例")} · {t("每日报告")} · {selected.subject}</p>
              <h2 id="daily-report-title" aria-live="polite">{selected.title}</h2>
              <dl>
                <div><dt>{t("事实")}</dt><dd>{selected.fact}</dd></div>
                <div><dt>{t("判断")}</dt><dd>{selected.judgment}</dd></div>
                <div><dt>{t("影响")}</dt><dd>{selected.impact}</dd></div>
                <div><dt>{t("下一步")}</dt><dd>{selected.next}</dd></div>
              </dl>
              <p className="daily-report-sources">{t("依据")} · {selected.sources}</p>
            </article>

            {selected.followUps.map((reply) => (
              <div className="daily-reports-message" key={`${selected.id}-${reply.agent}-${reply.time}`}>
                <div className="daily-reports-byline"><strong>{reply.agent}</strong><time>{reply.time}</time></div>
                <p>{reply.text}</p>
              </div>
            ))}
            {(replies[selected.id] ?? []).map((text, index) => (
              <div className="daily-reports-message daily-reports-message-own" key={`${selected.id}-reply-${index}`}>
                <div className="daily-reports-byline"><strong>{t("你")}</strong></div>
                <p>{text}</p>
              </div>
            ))}
          </div>

          <form className="daily-reports-compose" onSubmit={sendReply}>
            <label className="sr-only" htmlFor="daily-report-reply">{t("回复")}</label>
            <input id="daily-report-reply" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={t("回复")} />
            <button type="submit" disabled={!draft.trim()}>{t("发送")}</button>
          </form>
        </div>

        <aside className="daily-reports-queue" aria-labelledby="daily-reports-queue-title">
          <div className="daily-reports-queue-heading">
            <h2 id="daily-reports-queue-title">{t("今日汇报")}</h2>
            <span>{t("示例")} · {unreadCount} {t("未读")}</span>
          </div>
          <div className="daily-reports-tiles">
            {reports.map((report) => {
              const selectedTile = report.id === selectedId;
              const unread = !readIds.includes(report.id);
              return (
                <button
                  className="daily-reports-tile"
                  type="button"
                  key={report.id}
                  onClick={() => openReport(report.id)}
                  aria-pressed={selectedTile}
                  aria-label={`${report.title}，${report.agent}，${unread ? t("未读") : t("已读")}`}
                >
                  <span className="daily-reports-tile-title">{report.title}</span>
                  {unread && <span className="daily-reports-unread" aria-hidden="true" />}
                  <span className="daily-reports-tile-agent">{report.agent}</span>
                  <span className="daily-reports-tile-subject">{report.subject}</span>
                </button>
              );
            })}
          </div>
        </aside>
      </div>
    </section>
  );
}
