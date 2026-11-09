const KEY = "spontra.stage.reopen";
let reloading = false;

const mark = () => { try { sessionStorage.setItem(KEY, "1"); return true; } catch { return false; } };
const clear = () => { try { sessionStorage.removeItem(KEY); } catch { /* Nothing was kept. */ } };

/** Whether this page load is the one a missing chunk asked for, so the console comes back open. */
export const reopening = () => { try { return sessionStorage.getItem(KEY) !== null; } catch { return false; } };

/**
 * A page opened before a release asks for chunks that release removed. The first failure reloads the page onto the
 * current build; a failure on the page that reload brought is the caller's to show, so it can never loop.
 */
export function recoverable<T>(load: () => Promise<T>): () => Promise<T> {
  return () => load().then(
    module => { clear(); return module; },
    (error: unknown) => {
      if (reloading) return new Promise<T>(() => {});
      if (reopening()) { clear(); throw error; }
      if (!mark()) throw error;
      reloading = true;
      location.reload();
      return new Promise<T>(() => {});
    },
  );
}
