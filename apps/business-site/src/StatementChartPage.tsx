import { useEffect, useState, useSyncExternalStore } from "react";
import { messages, useLocale } from "@/packages/web/src/i18n";
import type { PublicBusinessFlow } from "@/shared/analysis-contract/business-flow";
import type { PublicCapitalStructure } from "@/shared/analysis-contract/capital-structure";
import "@/packages/web/src/business-flow/business-flow.css";
import { BusinessMap } from "./BusinessMap";
import { CompanyHttpError, fetchCapital, fetchCompany, publicationFlow, type CompanyPublication } from "./company-data";


const m = messages({
  loading: "Loading statement", unavailable: "Statement not available yet", failed: "Could not load the statement",
  retry: "Retry", quarter: "Quarter", cumulative: "Cumulative",
}, {
  loading: "正在加载报表", unavailable: "暂无可用报表", failed: "报表加载失败",
  retry: "重试", quarter: "单季", cumulative: "累计",
});

type Resource<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "failed" };
type Statement = "profit" | "cash" | "balance";
type Income = { flow: PublicBusinessFlow; history: CompanyPublication["history"] };

const subscribe = (listener: () => void) => {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
};
const readView = (): Statement => {
  const view = new URLSearchParams(location.search).get("view");
  return view === "cash" || view === "balance" ? view : "profit";
};

const date = (day: string) => day.replaceAll("-", ".");

export default function StatementChartPage({ ticker }: { ticker: string }) {
  const locale = useLocale();
  const view = useSyncExternalStore(subscribe, readView);
  const [income, setIncome] = useState<Resource<Income | null>>({ status: "loading" });
  const [capital, setCapital] = useState<Resource<PublicCapitalStructure | null>>({ status: "loading" });
  const [attempt, retry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const readIncome = async () => {
      try {
        const response = await fetchCompany(ticker, signal);
        const flow = publicationFlow(response, ticker);
        const value = flow?.quarters.length ? { flow, history: response.history } : null;
        if (!signal.aborted) setIncome({ status: "ready", value });
      } catch {
        if (!signal.aborted) setIncome({ status: "failed" });
      }
    };
    const readCapital = async () => {
      try {
        const value = await fetchCapital(ticker, signal);
        if (!signal.aborted) setCapital({ status: "ready", value });
      } catch (error) {
        if (!signal.aborted) setCapital(error instanceof CompanyHttpError && error.status === 503
          ? { status: "ready", value: null } : { status: "failed" });
      }
    };
    void readIncome();
    void readCapital();
    return () => controller.abort();
  }, [ticker, locale, attempt]);

  const resource = view === "profit" ? income : capital;
  const published = income.status === "ready" ? income.value : null;
  const quarter = published?.flow.quarters.reduce((latest, candidate) => candidate.periodEnd > latest.periodEnd ? candidate : latest);
  const funding = capital.status === "ready" ? capital.value?.quarters
    .filter(period => view === "cash" ? period.cashFlow || period.yearToDate : period.balanceSheet)
    .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0] : null;
  const balance = funding?.balanceSheet;
  const cash = funding?.cashFlow ?? funding?.yearToDate;
  // Using the cash statement's own start and end avoids labelling cumulative amounts as quarterly.
  const chartDate = view === "profit" && quarter ? `${date(quarter.periodEnd)} · ${m.quarter}`
    : view === "cash" && cash ? `${date(cash.periodStart)}–${date(cash.periodEnd)} · ${funding?.cashFlow ? m.quarter : m.cumulative}`
    : balance ? date(balance.asOf) : "";
  const available = view === "profit" ? Boolean(quarter) : view === "cash" ? Boolean(cash) : Boolean(balance);
  const emptyFlow: PublicBusinessFlow = { schemaVersion: "business-flow.v1", ticker, fetchedAt: null, quarters: [] };

  return <main className="statement-chart-page">
    {resource.status === "loading" ? <p className="statement-chart-status" role="status">{m.loading}</p>
      : resource.status === "failed" ? <div className="statement-chart-status" role="alert">
        <p>{m.failed}</p>
        <button type="button" onClick={() => {
          if (view === "profit") setIncome({ status: "loading" }); else setCapital({ status: "loading" });
          retry(value => value + 1);
        }}>{m.retry}</button>
      </div>
      : available ? <figure className="statement-chart-figure" key={view}>
        <figcaption>{chartDate}</figcaption>
        <BusinessMap ticker={ticker} tools={null} flow={published?.flow ?? emptyFlow} revenueHistory={published?.history ?? null}
          statementsOnly chartOnlyView={view} chartFunding={funding} />
      </figure> : <p className="statement-chart-status" role="status">{m.unavailable}</p>}
  </main>;
}
