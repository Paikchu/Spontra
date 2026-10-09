import type { ReactNode } from "react";

/** Final articles can wrap; a live preview retains a stable two-column group until reopened. */
export function ReportMediaGroup({ lead, media, children, sources, surface = "article", phase = "final", layout = "wrap" }: {
  lead?: ReactNode; media: ReactNode; children: ReactNode; sources?: ReactNode;
  surface?: "article" | "chat"; phase?: "draft" | "final"; layout?: "inline" | "aside" | "wrap" | "wide";
}) {
  return <div className="report-content-group" data-media-layout={surface === "chat" ? "inline" : phase === "draft" && layout === "wrap" ? "aside" : layout}>
    {lead && <div className="report-content-group-lead">{lead}</div>}
    <div className="report-content-group-body"><div className="report-content-group-media">{media}</div><div className="report-content-group-prose">{children}</div></div>
    {sources && <div className="report-content-group-sources">{sources}</div>}
  </div>;
}
