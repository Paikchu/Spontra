import { Button } from "@/packages/web/src/ui/button";
import { KIND_LABEL, type VerifiedFinding } from "./findings-model";

/**
 * The report's findings as a section of the rail, most severe first. One row in focus reshapes the
 * stage; 逐条看 walks them in order. Nothing here is a summary: each row is a claim the data supports.
 */
export function FindingsList({ findings, focus, story, periodEnd, onFocus, onStory }: {
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
  return <section className="findings" aria-label="本期要点" data-focus={focus ? "" : undefined}>
    <header className="findings-head">
      <span className="findings-title">要点<small>{periodEnd.slice(0, 7).replace("-", ".")} 财报{focus ? ` · ${index + 1}/${findings.length}` : ""}</small></span>
      <Button variant="unstyled" type="button" className="findings-story" aria-pressed={story} onClick={onStory}>{story ? "退出逐条看" : "逐条看"}</Button>
    </header>
    <div className="findings-rows" role="radiogroup" aria-label="选择要点以在图中聚焦">
      {findings.map(f => <Button variant="unstyled" type="button" key={f.id} role="radio" aria-checked={focus === f.id} className="finding-row" data-kind={f.kind}
        onClick={() => onFocus(focus === f.id ? null : f.id)} title={`重要程度 ${f.severity} · ${KIND_LABEL[f.kind]}`}>
        <i className="finding-mark" aria-label={`重要程度 ${f.severity}`}>{f.severity}</i>
        <span className="finding-title">{f.title}</span>
        <span className="finding-kind">{KIND_LABEL[f.kind]}{f.watchOutcome && <i className="finding-settled" title="跟踪项已有新披露" aria-label="跟踪项已有新披露">↻</i>}</span>
      </Button>)}
    </div>
  </section>;
}
