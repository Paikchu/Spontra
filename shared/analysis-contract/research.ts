export type { ResearchReport, ResearchSource } from "../analysis-runtime/research-schema.ts";

export type ResearchMonitorState = {
  enabled: boolean;
  holdingsAsOf: string | null;
  lastScanAt: string | null;
  tickers: string[];
  issues: Array<{ ticker: string; source: string; message: string; observedAt: string }>;
};

export type ResearchFeed = {
  reports: import("./research.ts").ResearchReport[];
  nextCursor: string | null;
  monitor: ResearchMonitorState;
};
