import { Button } from "@/packages/web/src/ui/button";
import { KIND_LABEL, type VerifiedFinding } from "./findings-model";
import { RailSection } from "./RailSection";

/** How many findings the rail shows before the section is opened. */
const DIGEST = 3;

/**
 * The report's findings as a section of the rail, most severe first; the mark's colour is the kind, its number the
 * severity. Closed, it shows the top few (and the one in focus). One row in focus reshapes the stage; play walks them in order.
 * Nothing here is a summary: each row is a claim the data supports.
 */
export function FindingsList({ findings, focus, story, periodEnd, expanded, onFocus, onStory, onExpand }: {
  findings: VerifiedFinding[];
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
  return <RailSection name="findings" title="要点" hint={`${periodEnd.slice(0, 7)} 财报`} expandable={findings.some(extra)}
    expanded={expanded} focused={focus != null} onExpand={onExpand}
    actions={<Button variant="unstyled" type="button" className="icon-button section-action" aria-pressed={story} aria-label={story ? "退出逐条看" : "逐条看"} title={story ? "退出逐条看" : "逐条看 (← →)"} onClick={onStory}>
      <svg viewBox="0 0 24 24" aria-hidden="true">{story ? <rect x="7" y="7" width="10" height="10" rx="2" /> : <path d="M8 6.5v11l9-5.5Z" />}</svg>
    </Button>}>
    <div className="findings-rows section-body" id="rail-findings" role="radiogroup" aria-label="选择要点以在图中聚焦">
      {findings.map((f, i) => <Button variant="unstyled" type="button" key={f.id} role="radio" aria-checked={focus === f.id} className="finding-row" data-kind={f.kind}
        data-extra={extra(f, i) ? "" : undefined} onClick={() => onFocus(focus === f.id ? null : f.id)} title={`${KIND_LABEL[f.kind]} · 重要程度 ${f.severity}`}>
        <i className="finding-mark" aria-label={`${KIND_LABEL[f.kind]} · 重要程度 ${f.severity}`}>{f.severity}</i>
        <span className="finding-title">{f.title}{f.watchOutcome && <i className="finding-settled" title="跟踪项已有新披露" aria-label="跟踪项已有新披露">↻</i>}</span>
      </Button>)}
    </div>
  </RailSection>;
}
