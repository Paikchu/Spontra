import { messages, useLocale, type Locale } from "@/packages/web/src/i18n";
import type { PublishedArtifact } from "@/shared/analysis-contract/artifact";

const m = messages({
  translated: "Chinese translation", chinese: "Chinese report", english: "English original",
  pending: "English original · Chinese translation pending",
  translating: "English original · Translating into Chinese",
  checking: "English original · Checking Chinese translation",
  failed: "English original · Chinese translation failed",
  previousPending: "Previous Chinese translation · Update pending",
  previousTranslating: "Previous Chinese translation · Updating",
  previousChecking: "Previous Chinese translation · Checking update",
  previousFailed: "Previous Chinese translation · Update failed",
}, {
  translated: "中文译文", chinese: "中文正文", english: "英文原文",
  pending: "英文原文 · 等待中文翻译",
  translating: "英文原文 · 中文翻译中",
  checking: "英文原文 · 中文译文检查中",
  failed: "英文原文 · 中文翻译失败",
  previousPending: "上版中文译文 · 等待更新",
  previousTranslating: "上版中文译文 · 更新中",
  previousChecking: "上版中文译文 · 更新检查中",
  previousFailed: "上版中文译文 · 更新失败",
});

/** The language of the published body and the translation state for that exact source version. */
export function artifactLanguageText(artifact: Pick<PublishedArtifact, "lang" | "translation">, locale: Locale) {
  const translation = artifact.translation;
  const previous = { pending: m.previousPending, translating: m.previousTranslating, checking: m.previousChecking, failed: m.previousFailed };
  return artifact.lang === "zh-CN" ? !translation ? m.chinese : translation.status === "ready" ? m.translated : previous[translation.status]
    : locale === "zh-CN" && translation && translation.status !== "ready" ? m[translation.status] : m.english;
}

export function ArtifactLanguage({ artifact }: { artifact: Pick<PublishedArtifact, "lang" | "translation"> }) {
  const locale = useLocale();
  return <span className="source-lang artifact-language" lang={locale} data-content-lang={artifact.lang}
    data-translation-status={artifact.translation?.status ?? "original"} role="status">{artifactLanguageText(artifact, locale)}</span>;
}
