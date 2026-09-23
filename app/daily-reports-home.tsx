"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useLanguage } from "./language-provider";
import { sampleReports as reports } from "@/lib/sample-reports";
import { NodeArrow } from "@/components/spontra/primitives";

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
            <Link href="/ledger" className="sp-btn sp-btn-secondary sp-btn-sm">{t("投资账本")}</Link>
          </header>

          <div className="daily-reports-thread" aria-label={t("汇报对话")}>
            <div className="daily-reports-byline"><strong>{selected.agent}</strong><time>{selected.time}</time></div>
            <article className="daily-report-document sp-lit" aria-labelledby="daily-report-title">
              <p className="daily-report-kicker">{t("示例")} · {t("每日报告")} · {selected.subject}</p>
              <h2 id="daily-report-title" aria-live="polite">{selected.title}</h2>
              <dl>
                <div><dt>{t("事实")}</dt><dd>{selected.fact}</dd></div>
                <div><dt>{t("判断")}</dt><dd><mark className="sp-hl is-soft">{selected.judgment}</mark></dd></div>
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
            <p className="daily-reports-compose-context"><span>{t("正在回复")}</span>{selected.title} · {selected.agent}</p>
            <div className="daily-reports-compose-row">
              <label className="sr-only" htmlFor="daily-report-reply">{t("回复")}</label>
              <input id="daily-report-reply" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={t("回复这份汇报")} />
              <button type="submit" disabled={!draft.trim()} data-ready={Boolean(draft.trim())} aria-label={t("发送")}><NodeArrow dir="up" /></button>
            </div>
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
