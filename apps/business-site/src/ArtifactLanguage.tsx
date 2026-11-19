import { messages, useLocale, type Locale } from "@/packages/web/src/i18n";
import type { PublishedArtifact } from "@/shared/analysis-contract/artifact";

const m = messages({
  chinese: "Chinese report", english: "English original",
  pending: "English original · Chinese translation pending",
  translating: "English original · Translating into Chinese",
  checking: "English original · Checking Chinese translation",
  failed: "English original · Chinese translation failed",
  previousPending: "Translation update pending",
  previousTranslating: "Updating translation",
  previousChecking: "Checking translation update",
  previousFailed: "Translation update failed",
}, {
  chinese: "中文正文", english: "英文原文",
  pending: "英文原文 · 等待中文翻译",
  translating: "英文原文 · 中文翻译中",
  checking: "英文原文 · 中文翻译检查中",
  failed: "英文原文 · 中文翻译失败",
  previousPending: "翻译等待更新",
  previousTranslating: "翻译更新中",
  previousChecking: "翻译更新检查中",
  previousFailed: "翻译更新失败",
});

/** The language of the published body and the translation state for that exact source version. */
export function artifactLanguageText(artifact: Pick<PublishedArtifact, "lang" | "translation">, locale: Locale) {
  const translation = artifact.translation;
  const previous = { pending: m.previousPending, translating: m.previousTranslating, checking: m.previousChecking, failed: m.previousFailed };
  return artifact.lang === "zh-CN" ? !translation ? m.chinese : translation.status === "ready" ? null : previous[translation.status]
    : locale === "zh-CN" && translation && translation.status !== "ready" ? m[translation.status] : m.english;
}

export function ArtifactLanguage({ artifact, row = false }: { artifact: Pick<PublishedArtifact, "lang" | "translation">; row?: boolean }) {
  const locale = useLocale();
  const text = artifactLanguageText(artifact, locale);
  if (!text) return null;
  const badge = <span className="source-lang artifact-language" lang={locale} data-content-lang={artifact.lang}
    data-translation-status={artifact.translation?.status ?? "original"} role="status">{text}</span>;
  return row ? <div className="artifact-language-row">{badge}</div> : badge;
}
