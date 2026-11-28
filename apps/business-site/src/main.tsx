import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { messages } from "@/packages/web/src/i18n";
import "./article-preview.css";

const m = messages({ notFound: "Not found" }, { notFound: "页面不存在" });
const ArticlePreview = lazy(() => import("./ArtifactPreviewPage"));

const isPreview = typeof location !== "undefined" && (location.pathname === "/article-preview" || location.pathname === "/article-preview/");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isPreview ? (
      <Suspense fallback={null}>
        <ArticlePreview />
      </Suspense>
    ) : (
      <main className="article-preview">
        <p className="article-preview-message" role="alert">{m.notFound}</p>
      </main>
    )}
  </StrictMode>,
);
