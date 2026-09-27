"use client";

import Link from "@/packages/ui/src/navigation";

export default function AnalysisError({ reset }: { reset: () => void }) {
  return <main className="sec-home" role="alert">
    <div><h1>暂时无法读取财报</h1>
      <p>数据服务暂时不可用，请稍后重试。</p>
      <button type="button" onClick={reset}>重试</button>{" · "}
      <Link href="/analysis">返回公司搜索</Link>
    </div>
  </main>;
}
