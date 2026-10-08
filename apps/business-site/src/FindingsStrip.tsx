import { Button } from "@/components/ui/button";
import { KIND_LABEL, type VerifiedFinding } from "./findings-model";

/**
 * The report's findings as a row of chips, most severe first. One chip in focus reshapes the stage;
 * 逐条看 walks them in order. Nothing here is a summary: each chip is a claim the data supports.
 */
export function FindingsStrip({ findings, focus, story, periodEnd, onFocus, onStory }: {
  findings: VerifiedFinding[];
  focus: string | null;
  story: boolean;
  /** The report the findings were written from. */
  periodEnd: string;
  onFocus: (id: string | null) => void;
  onStory: () => void;
}) {
  if (!findings.length) return null;
  const index = findings.findIndex(f => f.id === focus);
  return <nav className="findings" aria-label="本期要点" data-focus={focus ? "" : undefined}>
    <span className="findings-title">要点<small>{periodEnd.slice(0, 7).replace("-", ".")} 财报</small></span>
    <div className="findings-chips" role="radiogroup" aria-label="选择要点以在图中聚焦">
      {findings.map(f => <Button variant="unstyled" type="button" key={f.id} role="radio" aria-checked={focus === f.id} className="finding-chip" data-kind={f.kind}
        onClick={() => onFocus(focus === f.id ? null : f.id)} title={`${KIND_LABEL[f.kind]} · ${f.judgment.text.slice(0, 60)}…`}>
        <i className="finding-mark" aria-hidden="true">{f.severity}</i>
        <span>{f.title}</span>
        {f.watchOutcome && <i className="finding-settled" title="跟踪项已有新披露" aria-label="跟踪项已有新披露">↻</i>}
      </Button>)}
    </div>
    <div className="findings-tools">
      {focus && <span className="findings-count" aria-live="polite">{index + 1} / {findings.length}</span>}
      <Button variant="unstyled" type="button" className="findings-story" aria-pressed={story} onClick={onStory}>{story ? "退出逐条看" : "逐条看 ▸"}</Button>
      {focus && !story && <Button variant="unstyled" type="button" className="findings-story" onClick={() => onFocus(null)}>全部</Button>}
    </div>
  </nav>;
}
