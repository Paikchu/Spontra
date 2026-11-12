import { messages, useLocale } from "@/packages/web/src/i18n";
import type { PublishedArtifact } from "@/shared/analysis-contract/artifact";

const m = messages({
  translated: "Chinese translation", chinese: "Chinese report", english: "English original",
  pending: "English original · Chinese translation pending",
  translating: "English original · Translating into Chinese",
  checking: "English original · Checking Chinese translation",
  failed: "English original · Chinese translation failed",
}, {
  translated: "中文译文", chinese: "中文正文", english: "英文原文",
  pending: "英文原文 · 等待中文翻译",
  translating: "英文原文 · 中文翻译中",
  checking: "英文原文 · 中文译文检查中",
  failed: "英文原文 · 中文翻译失败",
});

/** The language of the published body and the translation state for that exact source version. */
export function ArtifactLanguage({ artifact }: { artifact: Pick<PublishedArtifact, "lang" | "translation"> }) {
  const locale = useLocale();
  const translation = artifact.translation;
  const text = artifact.lang === "zh-CN" ? translation?.status === "ready" ? m.translated : m.chinese
    : locale === "zh-CN" && translation && translation.status !== "ready" ? m[translation.status] : m.english;
  return <span className="source-lang artifact-language" lang={locale} data-content-lang={artifact.lang}
    data-translation-status={translation?.status ?? "original"} role="status">{text}</span>;
}
