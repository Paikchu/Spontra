import type { Metadata } from "next";
import "./earning-report.css";

export const metadata: Metadata = {
  title: "公司业务分析 · Spontra",
  description: "SEC 披露、财务指标与可追溯的公司研报。",
};

export default function AnalysisLayout({ children }: { children: React.ReactNode }) {
  return <div className="earning-report">{children}</div>;
}
