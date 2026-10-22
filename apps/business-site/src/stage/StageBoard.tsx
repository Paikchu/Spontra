import { Button } from "@/packages/web/src/ui/button";
import { messages } from "@/packages/web/src/i18n";
import { langOf } from "@/packages/web/src/i18n/SourceLanguage";
import type { CompanyData } from "../live-company";
import SceneView, { NOTICE } from "./SceneView";
import { isDefaultScene, type StageResult, type StageState } from "./stage-model";

const m = messages({
  reading: "Reading", laying: "Laying out", answering: "Answering", report: "Report", start: "Start", skip: "Skip",
}, {
  reading: "读取中", laying: "排版中", answering: "回答中", report: "报告", start: "开始", skip: "不用了",
});

/**
 * The stage while the reader talks with it (docs/stage-agent-design.md §5): the latest question's turn as it runs, then
 * its result in the stage's own space. A scene, or a report the reader started, is drawn from the agent's state; an
 * answer, a proposed report or a failure is laid out here. Each result enters as its own piece, so a new one replaces
 * the last with the stage's rise.
 */
export default function StageBoard({ ticker, data, scene, result, onOpenFinding, onAnswer }: {
  ticker: string; data: CompanyData; scene: StageState | null; result: StageResult | null;
  onOpenFinding: (id: string) => void; onAnswer: (questionId: string, yes: boolean) => void;
}) {
  if (result?.kind === "loading") return <section key="loading" className="board board-loading" aria-busy="true">
    <p className="board-question" lang={langOf(result.question)}>{result.question}</p>
    <p className="board-phase" role="status"><i aria-hidden="true" />{result.phase === "staging" ? m.laying : result.phase === "answering" ? m.answering : m.reading}</p>
    <div className="board-skeleton" aria-hidden="true"><span /><span /><span /><span /></div>
  </section>;
  if (result?.kind === "answer") return <article key={result.entry.id} className="board board-answer">
    <h2 className="board-question" lang={langOf(result.question)}>{result.question}</h2>
    <div className="board-prose" lang={result.entry.contentLanguage === "zh-CN" ? "zh-CN" : "en"}>{result.entry.paragraphs.map((p, i) => <p key={i}>{p.text}</p>)}</div>
  </article>;
  if (result?.kind === "proposal") return <section key={result.entry.id} className="board board-proposal">
    <b className="board-kind">{m.report}</b>
    <h2 lang={langOf(result.entry.question)}>{result.entry.question}</h2>
    <div className="board-actions">
      <Button variant="unstyled" type="button" className="board-yes" onClick={() => onAnswer(result.entry.questionId, true)}>{m.start}</Button>
      <Button variant="unstyled" type="button" onClick={() => onAnswer(result.entry.questionId, false)}>{m.skip}</Button>
    </div>
  </section>;
  if (result?.kind === "notice") return <section key={`n-${result.code}`} className="board board-notice">
    <p className="board-question" lang={langOf(result.question)}>{result.question}</p>
    <p className="board-notice-text">{NOTICE[result.code]}</p>
  </section>;
  return scene && !isDefaultScene(scene.scene.rows)
    ? <div key="scene" className="board board-scene"><SceneView ticker={ticker} scene={scene} data={data} onOpenFinding={onOpenFinding} /></div>
    : null;
}
