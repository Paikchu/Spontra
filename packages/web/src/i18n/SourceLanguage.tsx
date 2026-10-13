import { messages, useLocale, type Locale } from "./index";

const m = messages({ en: "English", zh: "Chinese" }, { en: "英文原文", zh: "中文原文" });

/**
 * A tag beside generated analysis that is not in the reader's language yet: it names the language the text is in.
 * Renders nothing when the two match. The text itself carries `lang` so fonts and screen readers treat it as that language.
 */
export function SourceLanguage({ lang = "en", className = "source-lang" }: { lang?: Locale; className?: string }) {
  const locale = useLocale();
  if (locale === lang) return null;
  return <span className={className} lang={locale}>{lang === "en" ? m.en : m.zh}</span>;
}
