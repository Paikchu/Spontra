import { langOf } from "@/shared/analysis-runtime/translation";
import { messages, useLocale, type Locale } from "./index";

const m = messages({ en: "English", zh: "Chinese" }, { en: "英文原文", zh: "中文原文" });

/** The `lang` of a piece of generated text: Chinese once translated, English until then. */
export { langOf };

/**
 * A tag beside generated analysis that is not in the reader's language yet: it names the language the text is in.
 * `of` is the block's generated text; the tag shows while any of it is still in another language than the page, so it
 * disappears by itself once the pipeline's translation of that text arrives. Without `of`, `lang` states it directly.
 */
export function SourceLanguage({ of, lang, className = "source-lang" }: { of?: string | null | ReadonlyArray<string | null | undefined>; lang?: Locale; className?: string }) {
  const locale = useLocale();
  const texts = of == null ? [] : typeof of === "string" ? [of] : of.filter((t): t is string => !!t);
  const shown: Locale = lang ?? (of == null ? "en" : texts.some(t => langOf(t) !== locale) ? (locale === "en" ? "zh-CN" : "en") : locale);
  if (shown === locale) return null;
  return <span className={className} lang={locale}>{shown === "en" ? m.en : m.zh}</span>;
}
