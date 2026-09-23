import { LocalizedText } from "../language-provider";

const modules = [
  { title: "利率与美债", text: "期限利差、实际利率与持仓估值的关系。" },
  { title: "通胀与就业", text: "CPI、PCE、非农发布后，哪些持仓的判断需要复核。" },
  { title: "流动性与美元", text: "美元指数与市场流动性对成长股的影响。" },
  { title: "事件日历", text: "未来七天的高影响宏观事件，与你的持仓关联。" },
];

/** Honest placeholder: the macro dashboard is planned, so no numbers are shown here. */
export default function Page() {
  return (
    <main aria-labelledby="macro-title" className="page-shell macro-page">
      <header className="macro-heading">
        <span className="sp-badge sp-badge-outline"><LocalizedText>规划中</LocalizedText></span>
        <h1 id="macro-title"><LocalizedText>宏观分析</LocalizedText></h1>
        <p><LocalizedText>这一页会回答：今天的利率、通胀和流动性变化，会怎样影响你的持仓。接入真实数据之前，这里不显示任何数字。</LocalizedText></p>
      </header>
      <ul className="macro-modules">
        {modules.map((item) => (
          <li key={item.title}>
            <span className="sp-ev sp-ev-pending"><svg className="sp-ev-glyph" viewBox="0 0 10 10" aria-hidden="true"><circle cx={5} cy={5} r={3.4} fill="none" strokeWidth={1.4} /></svg><LocalizedText>待接入</LocalizedText></span>
            <strong><LocalizedText>{item.title}</LocalizedText></strong>
            <p><LocalizedText>{item.text}</LocalizedText></p>
          </li>
        ))}
      </ul>
    </main>
  );
}
