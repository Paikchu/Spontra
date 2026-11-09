import { isReopenable } from "./desktop-model";

/**
 * Imported first by the boot script: every module after it reads the address when it loads, and the page's load timing
 * has to see the page that is really opening.
 */
const LAST_PAGE_KEY = "business-map-desktop-page";

const read = () => { try { return localStorage.getItem(LAST_PAGE_KEY); } catch { return null; } };

const last = read();
if (location.pathname === "/" && !location.search && last && last !== "/" && isReopenable(last)) history.replaceState(null, "", last);

const remember = () => {
  const page = location.pathname + location.search;
  if (!isReopenable(page) || page === read()) return;
  try { localStorage.setItem(LAST_PAGE_KEY, page); } catch { /* Storage may be disabled. */ }
};
for (const method of ["pushState", "replaceState"] as const) {
  const original = history[method].bind(history);
  history[method] = (...args: Parameters<History["pushState"]>) => { original(...args); remember(); };
}
