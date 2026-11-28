import { AiKindPanel } from "./ai-runs";
import { BusinessCharts } from "./business-charts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/web/shared/ui/tabs";
import "./business-charts.css";
export function BusinessSegments({ companyTicker, onUnauthorized }: { companyTicker: string; onAuthenticated: () => void; onUnauthorized: () => void }) {
  return <Tabs defaultValue="charts">
    <TabsList><TabsTrigger value="charts">图表数据</TabsTrigger><TabsTrigger value="tree">业务脑图</TabsTrigger><TabsTrigger value="explainer">业务解读</TabsTrigger></TabsList>
    <TabsContent value="charts"><BusinessCharts ticker={companyTicker} onUnauthorized={onUnauthorized}/></TabsContent>
    <TabsContent value="tree"><AiKindPanel ticker={companyTicker} kind="tree" onUnauthorized={onUnauthorized}/></TabsContent>
    <TabsContent value="explainer"><AiKindPanel ticker={companyTicker} kind="explainer" onUnauthorized={onUnauthorized}/></TabsContent>
  </Tabs>;
}
