import { useSyncExternalStore } from "react";
import { getLocale, subscribeLocale, type Locale } from "./core";

export * from "./core";

export const useLocale = (): Locale => useSyncExternalStore(subscribeLocale, getLocale, getLocale);
