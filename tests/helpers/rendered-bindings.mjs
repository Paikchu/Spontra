import { AsyncLocalStorage } from "node:async_hooks";

// Built Worker rendering tests supply the same API binding used in production.
export const bindings = new AsyncLocalStorage();
export const env = new Proxy({}, { get: (_target, key) => bindings.getStore()?.[key] });
