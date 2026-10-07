"use client";

import type { PortfolioSyncMetadata } from "@/shared/portfolio-contract";
import { useLanguage } from "@/app/language-provider";

export function PortfolioSyncNote({ sync }: { sync?: PortfolioSyncMetadata }) {
  const { language } = useLanguage();
  if (!sync || sync.syncStatus !== "delayed") return null;
  const en = language === "en";
  const time = sync.syncedAt ? new Intl.DateTimeFormat(en ? "en-GB" : "zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(sync.syncedAt)) : "—";
  return <p role="status" className="mt-2 text-xs text-muted-foreground">
    {en ? "Sync delayed · Report date " : "同步延迟 · 当前展示报告日期 "}{sync.reportDate ?? "—"}
    {en ? " · Last successful sync " : " · 上次成功同步 "}{time}{en ? " (Beijing)" : "（北京时间）"}
  </p>;
}

export function PortfolioUnavailable({ reason = "unavailable" }: { reason?: "uninitialized" | "unavailable" }) {
  const { language } = useLanguage();
  const en = language === "en";
  return <main className="page-shell py-8" id="main-content"><div role="status">
    <p>{reason === "uninitialized"
      ? (en ? "Portfolio data is awaiting its first sync." : "持仓数据尚未完成首次同步。")
      : (en ? "Portfolio data is temporarily unavailable." : "持仓数据暂时无法读取，请稍后重试。")}</p>
    <button className="sp-btn sp-btn-sm mt-3" onClick={() => window.location.reload()}>{en ? "Reload" : "重新加载"}</button>
  </div></main>;
}
