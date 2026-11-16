import { Button } from "@/packages/web/src/ui/button";
import { messages, useLocale } from "@/packages/web/src/i18n";
import { ArtifactFrame } from "./ArtifactFrame";
import { usePublishedArtifactRead } from "./artifact-reads";

const m = messages({ title: "Published research", loading: "Loading published research", missing: "This published research could not be loaded. Its original link has been preserved.", close: "Close research" }, { title: "已发布研究", loading: "正在加载已发布研究", missing: "暂时无法加载这份已发布研究，原始链接仍予保留。", close: "关闭研究" });
/** Compatibility surface for a saved finding URL after the detector publishes a different set of leads. */
export function HistoricalDossier({ ticker, findingId, onClose }: { ticker: string; findingId: string; onClose(): void }) {
  useLocale();
  const { artifact, status } = usePublishedArtifactRead(ticker, `dossier/${encodeURIComponent(findingId)}`);
  return <section className="lens report-lens" aria-label={m.title}>
    <header className="lens-head"><div className="lens-title"><b className="lens-kind">{m.title}</b><h2>{artifact?.title ?? m.title}</h2>{artifact && <span className="lens-basis">{artifact.publishedAt.slice(0, 10)} · v{artifact.version}</span>}</div><Button variant="unstyled" className="lens-close" aria-label={m.close} onClick={onClose}>✕</Button></header>
    <div className="report-document">
      {artifact ? <ArtifactFrame artifact={artifact} hostTitle={artifact.title} /> : <p className="lens-empty" role="status">{status === "loading" ? m.loading : m.missing}</p>}
    </div>
  </section>;
}
