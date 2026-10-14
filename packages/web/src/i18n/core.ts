import { isLocale, type Locale } from "@/shared/analysis-runtime/locale";

export type { Locale };
export { LOCALES } from "@/shared/analysis-runtime/locale";

/**
 * React-free core, safe to import from model code that also runs in a Worker (it resolves to "en" there).
 *
 * The reader's interface language. One value for the page, read from `?lang=`, then the saved choice, then the
 * browser's languages. Text and number forms read it when they are produced; the app remounts its tree when it
 * changes, so nothing computed under the previous locale survives a switch.
 */
const STORAGE_KEY = "business-map-locale";

function fromBrowser(): Locale {
  const languages = typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
  return languages.some(l => /^zh\b/i.test(l ?? "")) ? "zh-CN" : "en";
}

function resolve(): Locale {
  if (typeof window === "undefined") return "en";
  try {
    const param = new URLSearchParams(location.search).get("lang");
    if (isLocale(param)) { localStorage.setItem(STORAGE_KEY, param); return param; }
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    /* Storage may be disabled. */
  }
  return fromBrowser();
}

let current: Locale = resolve();
const listeners = new Set<() => void>();
if (typeof document !== "undefined") document.documentElement.lang = current;

export const getLocale = (): Locale => current;

export function setLocale(next: Locale) {
  if (next === current) return;
  current = next;
  if (typeof document !== "undefined") {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* Storage may be disabled. */
    }
    document.documentElement.lang = next;
    // A shared link keeps the language it was opened in only until the reader picks another one.
    const url = new URL(location.href);
    if (url.searchParams.has("lang")) { url.searchParams.delete("lang"); history.replaceState(history.state, "", url); }
  }
  listeners.forEach(l => l());
}

/** Called whenever the locale changes; returns the unsubscribe. */
export const subscribeLocale = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/**
 * Every table made by messages() or labels(), kept only while an audit is collecting them (scripts/check-i18n.ts sets
 * the flag before loading the modules), so the page itself holds no second reference.
 */
export type MessageTable = { kind: "messages" | "labels"; origin: string; en: Record<string, unknown>; zh: Record<string, unknown> };
const AUDIT_KEY = "__spontraI18nAudit";
function register(kind: MessageTable["kind"], en: Record<string, unknown>, zh: Record<string, unknown>) {
  const audit = (globalThis as Record<string, unknown>)[AUDIT_KEY] as MessageTable[] | undefined;
  if (!audit) return;
  const frame = new Error().stack?.split("\n").slice(3).find(line => !line.includes("/i18n/core")) ?? "";
  audit.push({ kind, origin: frame.trim(), en, zh });
}

/** A message is a label, or a function of the figures or names it carries. */
type Message = string | ((...args: never[]) => string);

/**
 * One area's labels in every locale. `en` defines the keys and each function's arguments; `zh` must give every key
 * with the same shape, so a missing translation fails the type check rather than showing at run time.
 *
 *   const m = messages({ load: "Load failed", severity: (n: number) => `Severity ${n}` },
 *                      { load: "加载失败",    severity: (n: number) => `重要度 ${n}` });
 *   m.load; m.severity(3);
 */
export function messages<E extends Record<string, Message>>(en: E, zh: NoInfer<{ [K in keyof E]: E[K] }>): E {
  const table: Record<Locale, E> = { en, "zh-CN": zh };
  register("messages", en, zh);
  return new Proxy(en, { get: (_, key) => table[current][key as keyof E] });
}

/** A label per value of a closed set, in every locale: event classes, finding kinds, statement views. */
export function labels<K extends string>(en: Record<K, string>, zh: NoInfer<Record<K, string>>): Record<K, string> {
  const table: Record<Locale, Record<K, string>> = { en, "zh-CN": zh };
  register("labels", en, zh);
  return new Proxy(en, { get: (_, key) => table[current][key as K] });
}
