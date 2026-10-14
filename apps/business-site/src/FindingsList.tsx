import { Button } from "@/packages/web/src/ui/button";
import { messages } from "@/packages/web/src/i18n";
import { SourceLanguage } from "@/packages/web/src/i18n/SourceLanguage";
import { KIND_LABEL, type VerifiedFinding } from "./findings-model";
import { RailSection } from "./RailSection";

const m = messages({
  findings: "Findings", report: (period: string) => `${period} report`,
  stop: "Stop walk-through", walk: "Walk through", walkKeys: "Walk through (← →)",
  severity: (kind: string, n: number) => `${kind} · Severity ${n}`, watchOutcome: "Watch outcome",
}, {
  findings: "要点", report: (period: string) => `${period} 财报`,
  stop: "停止逐条浏览", walk: "逐条浏览", walkKeys: "逐条浏览（← →）",
  severity: (kind: string, n: number) => `${kind} · 重要度 ${n}`, watchOutcome: "跟踪结果",
});

/** How many findings the rail shows before the section is opened. */
const DIGEST = 3;

/**
 * The report's findings as a section of the rail, most severe first; the mark's colour is the kind, its number the
 * severity. Closed, it shows the top few (and the one in focus). One row in focus reshapes the stage; play walks them in order.
 * Nothing here is a summary: each row is a claim the data supports.
 */
export function FindingsList({ findings, verdicts, focus, story, periodEnd, expanded, onFocus, onStory, onExpand }: {
  findings: VerifiedFinding[];
  /** Pass or fail of each finding's scored watch, by finding id, once its period reported. */
  verdicts?: Record<string, "pass" | "fail">;
  focus: string | null;
  story: boolean;
  /** The report the findings were written from. */
  periodEnd: string;
  expanded: boolean;
  onFocus: (id: string | null) => void;
  onStory: () => void;
  onExpand: (open: boolean) => void;
}) {
  if (!findings.length) return null;
  const extra = (f: VerifiedFinding, i: number) => i >= DIGEST && f.id !== focus;
  return <RailSection name="findings" title={m.findings} tag={<SourceLanguage />} hint={m.report(periodEnd.slice(0, 7))} expandable={findings.some(extra)}
    expanded={expanded} focused={focus != null} onExpand={onExpand}
    actions={<Button variant="unstyled" type="button" className="icon-button section-action" aria-pressed={story} aria-label={story ? m.stop : m.walk} title={story ? m.stop : m.walkKeys} onClick={onStory}>
      <svg viewBox="0 0 24 24" aria-hidden="true">{story ? <rect x="7" y="7" width="10" height="10" rx="2" /> : <path d="M8 6.5v11l9-5.5Z" />}</svg>
    </Button>}>
    <div className="findings-rows section-body" id="rail-findings" role="radiogroup" aria-label={m.findings}>
      {findings.map((f, i) => <Button variant="unstyled" type="button" key={f.id} role="radio" aria-checked={focus === f.id} className="finding-row" data-kind={f.kind}
        data-extra={extra(f, i) ? "" : undefined} onClick={() => onFocus(focus === f.id ? null : f.id)} title={m.severity(KIND_LABEL[f.kind], f.severity)}>
        <i className="finding-mark" aria-label={m.severity(KIND_LABEL[f.kind], f.severity)}>{f.severity}</i>
        <span className="finding-title"><span lang="en">{f.title}</span>{f.watchOutcome && <i className="finding-settled" data-verdict={verdicts?.[f.id]} title={m.watchOutcome} aria-label={m.watchOutcome}>{verdicts?.[f.id] === "pass" ? "✓" : verdicts?.[f.id] === "fail" ? "✗" : "↻"}</i>}</span>
      </Button>)}
    </div>
  </RailSection>;
}
