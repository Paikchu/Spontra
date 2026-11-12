import { useEffect, useState } from "react";
import { z } from "zod";
import { messages, useLocale } from "@/packages/web/src/i18n";
import { ArtifactFrame } from "./ArtifactFrame";
import { ArtifactLanguage } from "./ArtifactLanguage";
import "./article-preview.css";

const m = messages({
  preview: "Report preview", loading: "Loading report", unavailable: "Preview link unavailable or expired",
}, {
  preview: "报告预览", loading: "加载报告中", unavailable: "预览链接不可用或已过期",
});

const previewResponse = z.object({ artifact: z.object({
  id: z.string(), title: z.string(), hash: z.string(), html: z.string(), css: z.string(), lang: z.enum(["en", "zh-CN"]),
  translation: z.union([
    z.object({ locale: z.literal("zh-CN"), status: z.literal("ready") }),
    z.object({ locale: z.literal("zh-CN"), status: z.enum(["pending", "translating", "checking", "failed"]), completed: z.number(), total: z.number() }),
  ]).nullable(),
}) });
type PreviewArtifact = z.infer<typeof previewResponse>["artifact"];
type PreviewState = { status: "loading" } | { status: "ready"; artifact: PreviewArtifact } | { status: "unavailable" };

/** A signed article stands on its own: previewing it reads no company modules or conversation state. */
export default function ArtifactPreviewPage() {
  const locale = useLocale();
  const [token] = useState(() => new URLSearchParams(location.search).get("token"));
  const [state, setState] = useState<PreviewState>({ status: "loading" });

  useEffect(() => {
    let light = false;
    try { light = localStorage.getItem("business-map-theme") === "light"; } catch { /* Storage may be disabled. */ }
    document.documentElement.classList.toggle("light", light);
    document.documentElement.classList.toggle("dark", !light);
  }, []);

  useEffect(() => {
    document.title = state.status === "ready" ? `${state.artifact.title} · Business View` : m.preview;
  }, [state, locale]);

  useEffect(() => {
    if (!token) { setState({ status: "unavailable" }); return; }
    const controller = new AbortController();
    void fetch(`/api/business/v1/artifact-preview/${encodeURIComponent(token)}`, { signal: controller.signal, cache: "no-store", referrerPolicy: "no-referrer" })
      .then(async response => {
        if (!response.ok) throw new Error("Preview unavailable");
        const body = previewResponse.parse(await response.json());
        if (!controller.signal.aborted) setState({ status: "ready", artifact: body.artifact });
      })
      .catch(() => { if (!controller.signal.aborted) setState({ status: "unavailable" }); });
    return () => controller.abort();
  }, [token]);

  return <main className="article-preview" aria-label={m.preview}>
    <div className="article-preview-document">
      {state.status === "ready" ? <>
        <header className="article-preview-head">
          <h1 lang={state.artifact.lang}>{state.artifact.title}</h1>
          <ArtifactLanguage artifact={state.artifact} />
        </header>
        <ArtifactFrame artifact={state.artifact} showLanguage={false} />
      </> : <p className="article-preview-message" role={state.status === "loading" ? "status" : "alert"}>
        {state.status === "loading" ? m.loading : m.unavailable}
      </p>}
    </div>
  </main>;
}
