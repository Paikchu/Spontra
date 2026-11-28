import { langOf } from "@/src/domains/publishing/translation-runtime";
import { messages, useLocale, type Locale } from "./";

const m = messages({ zh: "Chinese" }, { zh: "中文原文" });

/** The `lang` of a piece of generated text: Chinese once translated, English until then. */
export { langOf };

/**
 * Marks Chinese source text on the English interface. `lang` can specify the source language directly.
 */
export function SourceLanguage({ of, lang, className = "source-lang" }: { of?: string | null | ReadonlyArray<string | null | undefined>; lang?: Locale; className?: string }) {
  const locale = useLocale();
  if (locale !== "en") return null;
  const texts = of == null ? [] : typeof of === "string" ? [of] : of.filter((t): t is string => !!t);
  const chinese = lang ? lang === "zh-CN" : texts.some(text => langOf(text) === "zh-CN");
  return chinese ? <span className={className} lang={locale}>{m.zh}</span> : null;
}
