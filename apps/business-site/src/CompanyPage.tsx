import { Component, useState, type ReactNode } from "react";
import { messages, useLocale } from "@/packages/web/src/i18n";
import type { HomeCompany } from "@/shared/analysis-contract/home";
import "@/packages/web/src/business-flow/business-flow.css";
import { BusinessMap } from "./BusinessMap";
import { CompanySkeleton } from "./CompanySkeleton";
import { ErrorState } from "./ErrorState";
import { companyFault } from "./error-model";
import { openingFace, useLiveCompany } from "./live-company";
import { UpdateNotice } from "./UpdateNotice";
import { useStageHost } from "./stage/StageHost";
import { usePageTurning } from "./page-turn";
import { companyIdentity } from "./company-meta";
import type { CompanyOpening } from "./company-opening";

const m = messages({ lastSnapshot: "Last complete snapshot", title: "Business View" }, { lastSnapshot: "最近一次完整快照", title: "Business View" });

class ChartBoundary extends Component<
  { ticker: string; companies: Array<{ ticker: string; name: string }>; onHome: () => void; onSearch: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <ErrorState kind="server" code="RENDER" ticker={this.props.ticker} companies={this.props.companies} onHome={this.props.onHome} onSearch={this.props.onSearch} onRetry={() => this.setState({ failed: false })} restoredTitle={`${this.props.ticker} · ${m.title}`} />
    ) : (
      this.props.children
    );
  }
}
export default function CompanyPage({ ticker, opening, tools, onSeen, covered, companies, onHome, onSearch, catalog = null }: {
  ticker: string;
  opening: CompanyOpening;
  /** The home catalog's entry for this company: its Chinese name and latest fiscal period. */
  catalog?: HomeCompany | null;
  tools: ReactNode;
  onSeen: (ticker: string) => void;
  covered: boolean | null;
  companies: Array<{ ticker: string; name: string }>;
  onHome: () => void;
  onSearch: () => void;
}) {
  const { data, updates, failed, httpStatus, ready, settled, eventsPhase, retry, retryEvents, update, apply, dismiss } = useLiveCompany(ticker, onSeen, opening);
  const { flow, publication, capital, peers, findings, fundamentals, events, filings, valuation } = data;
  const stage = useStageHost(ticker, data);
  const locale = useLocale();
  const company = companyIdentity({ locale, catalog, issuer: publication?.issuer, explainerName: publication?.explainer?.companyName, treeName: publication?.tree?.companyName, flow, filings, events });
  // The page keeps the face it turned in with until the turn lands, since replacing its rail mid-flight cuts the turn short.
  const face = openingFace({ ready, failed, flow: Boolean(flow), publication: Boolean(publication) });
  const [arrival] = useState(face);
  const shown = usePageTurning() ? arrival : face;
  const fault = shown === "failed" || shown === "state" ? companyFault({
    httpStatus: shown === "failed" ? httpStatus : null,
    reasons: publication?.reasons ?? [],
    covered,
    attempted: Boolean(publication?.lastAttemptAt),
  }) : null;
  if (fault)
    return <ErrorState kind={fault.kind} code={fault.code} ticker={ticker} companies={companies} onHome={onHome} onRetry={retry} onSearch={onSearch} restoredTitle={`${ticker} · ${m.title}`} />;
  if (shown === "map" && flow)
    return (
      <ChartBoundary ticker={ticker} companies={companies} onHome={onHome} onSearch={onSearch}>
        <BusinessMap
          ticker={ticker}
          tools={tools}
          flow={flow}
          revenueHistory={publication?.history ?? null}
          explainer={publication?.explainer ?? null}
          tree={publication?.tree ?? null}
          guidance={publication?.guidance ?? null}
          capital={capital}
          findings={findings?.findings ?? null} peers={findings?.peers ?? null} rankPeers={peers} passages={findings?.passages ?? null}
          fundamentals={fundamentals}
          events={events}
          filings={filings}
          valuation={valuation}
          eventsPhase={eventsPhase}
          detailsLoading={!settled}
          onRetryEvents={retryEvents}
          notice={publication?.outdated ? m.lastSnapshot : null}
          updates={updates}
          stageOverride={stage.stageOverride}
          onNavigate={stage.onNavigate}
          onView={stage.onView}
          railFoot={stage.railFoot}
          focusRequest={stage.focusRequest}
          company={company}
        />
        <UpdateNotice update={update} onApply={apply} onDismiss={dismiss} />
        {stage.layer}
      </ChartBoundary>
    );
  return <CompanySkeleton ticker={ticker} tools={tools} />;
}
