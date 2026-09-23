"use server";

import Today from "./page";
import Ledger from "./ledger/page";
import Analysis from "./analysis/page";
import Settings from "./settings/page";
import Macro from "./macro/page";
import Chat from "./chat/page";
import { StockWorkspace } from "./positions/stock-workspace";
import { loadStock } from "./analysis/load-stock";
import AnalysisReport from "./analysis/stocks/[ticker]/sec/[accession]/page";

export async function loadAppPage(href: string) {
  const { pathname: path, searchParams } = new URL(href, "http://app.local");
  if (path === "/") return Today();
  if (path === "/ledger") return Ledger();
  if (path === "/analysis") return <div className="earning-report"><Analysis /></div>;
  if (path === "/chat") return <Chat />;
  if (path === "/settings") return <Settings />;
  if (path === "/macro") return <Macro />;
  const position = /^\/positions\/([^/]+)$/.exec(path);
  if (position) return <StockWorkspace stock={await loadStock(decodeURIComponent(position[1]))} />;
  const report = /^\/(positions|analysis\/stocks)\/([^/]+)\/sec\/([^/]+)$/.exec(path);
  if (report) {
    const params = Promise.resolve({ ticker: decodeURIComponent(report[2]), accession: decodeURIComponent(report[3]) });
    const query = Object.fromEntries(
      [...new Set(searchParams.keys())].map((key) => {
        const values = searchParams.getAll(key);
        return [key, values.length === 1 ? values[0] : values];
      }),
    );
    return <div className="earning-report">{await AnalysisReport({ params, searchParams: Promise.resolve(query) })}</div>;
  }
  throw new Error("未找到这个页面。");
}
