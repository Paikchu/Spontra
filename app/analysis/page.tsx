import { AnalysisWorkspace } from "./analysis-workspace";

export default function HomePage() {
  return (
    <AnalysisWorkspace>
      <main className="sec-home">
        <div className="sec-home-ambient" aria-hidden="true" />
        <div className="sec-home-copy">
          <p className="sec-home-kicker">SEC / AI</p>
          <h1>把财报读成<br /><mark className="sp-hl">可追溯</mark>的判断。</h1>
          <p>输入股票代码，查看历史 SEC 原始申报、结构化指标与完整 AI 研报。</p>
        </div>
        <ol className="sec-home-index">
          <li className="sp-lit"><span>01</span><strong>历史文件</strong><small>按申报日持续累积</small></li>
          <li className="sp-lit is-accent"><span>02</span><strong>原文证据</strong><small>每项结论回到 EDGAR</small></li>
          <li className="sp-lit"><span>03</span><strong>AI 解析</strong><small>仅展示已生成报告</small></li>
        </ol>
      </main>
    </AnalysisWorkspace>
  );
}
