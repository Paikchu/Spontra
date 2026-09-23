"use client";

import { useLanguage } from "./language-provider";

export function NavigationPlaceholder({ path, error, onRetry }: { path: string; error: string; onRetry: () => void }) {
  const { t } = useLanguage();
  const key = path.split("#")[0];
  const title = key === "/" ? "投资记录" : key === "/chat" ? "群聊" : key === "/settings" ? "设置" : key === "/macro" ? "宏观分析" : key.includes("/sec/") ? "财报分析" : key.startsWith("/positions/") ? "公司详情" : "公司业务分析";
  return <main className="page-shell navigation-placeholder" data-navigation-placeholder={key} aria-busy={!error}>
    <h1 className="text-2xl font-semibold tracking-tight">{t(title)}</h1>
    {error ? <div role="alert" className="mt-8 text-sm text-muted-foreground">
      <p>{t(error)}</p>
      <button type="button" onClick={onRetry} className="mt-4 rounded-md border px-4 py-2 text-foreground hover:bg-muted focus-visible:outline-2">{t("重新加载页面")}</button>
    </div> : <>
      <p role="status" className="mt-3 text-sm text-muted-foreground">{t("正在加载页面")}</p>
      <div aria-hidden="true" className="navigation-skeleton mt-8 grid gap-6">
        <div className={key === "/" ? "grid grid-cols-2 gap-4 md:grid-cols-4" : "grid gap-4"}>
          {Array.from({ length: key === "/" ? 4 : 1 }, (_, index) => <div key={index} className="h-24 rounded-lg bg-muted" />)}
        </div>
        <div className="rounded-lg border p-5"><div className="mb-6 h-5 w-1/3 rounded bg-muted" />
          {[0, 1, 2, 3].map(index => <div key={index} className="my-4 h-8 rounded bg-muted" />)}
        </div>
      </div>
    </>}
  </main>;
}
