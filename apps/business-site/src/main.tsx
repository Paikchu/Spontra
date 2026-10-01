import { StrictMode, useEffect, useState, lazy, Suspense, Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
const BusinessFlow=lazy(()=>import("@/app/analysis/stocks/[ticker]/BusinessFlow").then(module=>({default:module.BusinessFlow})));
import { selectFlow } from "@/lib/earning-report/web/business-flow-model";
import { resolveCompanyBusiness } from "@/lib/earning-report/web/company-business-content";
import type { PublicBusinessFlow } from "@/shared/analysis-contract/business-flow";
import "@/app/analysis/stocks/[ticker]/business-flow.css";
import "./style.css";
import { withBusinessDescriptions } from "./business-description";

function tickerFromUrl(){const match=location.pathname.match(/^\/companies\/([A-Za-z0-9.-]{1,12})\/?$/);return match?match[1].toUpperCase():null;}
class ChartBoundary extends Component<{children:ReactNode},{failed:boolean}>{state={failed:false};static getDerivedStateFromError(){return {failed:true};}render(){return this.state.failed?<p role="alert">图表暂时无法显示，请重新加载；不会以示例数据替代真实披露。</p>:this.props.children;}}
function Company({ticker}:{ticker:string}){
 const [flow,setFlow]=useState<PublicBusinessFlow|null>(null),[failed,setFailed]=useState(false),[retry,setRetry]=useState(0);
 useEffect(()=>{const controller=new AbortController();fetch(`/api/business/v1/companies/${encodeURIComponent(ticker)}`,{signal:controller.signal}).then(async response=>{if(!response.ok)throw new Error("unavailable");const data=await response.json() as {flow?:PublicBusinessFlow};if(!controller.signal.aborted)setFlow(selectFlow(data.flow,null,ticker));}).catch(()=>{if(!controller.signal.aborted)setFailed(true);});return ()=>controller.abort();},[ticker,retry]);
 return <><div className="company-title"><h1>{ticker} <span>业务地图</span></h1><p>公开财报 · 业务归属与利润流向</p></div>{failed&&!flow?<div className="state" role="alert"><h2>数据暂时无法读取</h2><p>请稍后重试。未披露数据不会视为零。</p><button onClick={()=>{setFailed(false);setRetry(n=>n+1);}}>重试</button></div>:flow?<ChartBoundary><Suspense fallback={<p role="status">正在加载业务图…</p>}><BusinessFlow flow={withBusinessDescriptions(flow,resolveCompanyBusiness(ticker))} business={resolveCompanyBusiness(ticker)} notice={!flow.quarters.length?"当前公司尚无可用季度财务流；已公开业务归属仍可查看。":null}/></Suspense></ChartBoundary>:<p className="state" role="status">正在读取公开财报…</p>}</>;
}
function App(){
 const [ticker,setTicker]=useState(tickerFromUrl),[input,setInput]=useState(ticker??""),[invalid,setInvalid]=useState(false),[light,setLight]=useState(false);
 useEffect(()=>{const changed=()=>{const next=tickerFromUrl();setTicker(next);setInput(next??"");};window.addEventListener("popstate",changed);return ()=>window.removeEventListener("popstate",changed);},[]);
 function navigate(next:string|null){history.pushState(null,"",next?`/companies/${next}`:"/");setTicker(next);setInput(next??"");setInvalid(false);window.scrollTo(0,0);}
 return <><header className="site-header"><a href="/" onClick={event=>{event.preventDefault();navigate(null);}}>个股业务地图</a><button aria-label="切换明暗主题" aria-pressed={light} onClick={()=>{setLight(!light);document.documentElement.classList.toggle("dark",light);document.documentElement.classList.toggle("light",!light);}}>{light?"深色":"浅色"}</button></header><main><form className="company-picker" onSubmit={event=>{event.preventDefault();const value=input.trim().toUpperCase();if(!/^[A-Z][A-Z0-9.-]{0,11}$/.test(value)){setInvalid(true);return;}navigate(value);}}><label htmlFor="ticker">公司代码</label><input id="ticker" value={input} onChange={event=>setInput(event.target.value)} placeholder="例如 ORCL" maxLength={12} autoCapitalize="characters" autoComplete="off"/><button type="submit">查看业务</button>{ticker&&<button type="button" onClick={()=>navigate(null)}>返回公司选择</button>}{invalid&&<span role="alert">请输入有效的美股公司代码。</span>}</form>{ticker?<Company key={ticker} ticker={ticker}/>:<section className="welcome"><h1>读懂一家公司如何赚钱</h1><p>业务、产品与客户，以及收入如何经过成本费用变成净利润。</p><button onClick={()=>navigate("ORCL")}>查看 Oracle · ORCL</button><p className="coverage">目前 ORCL 已接入完整季度流向。其他公司按实际可用披露展示；金融、保险与亏损口径提供明细降级。</p></section>}</main><footer>仅展示公开公司财报与业务归属 · 金额与来源见图中披露 · 非投资建议</footer></>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><App/></StrictMode>);
