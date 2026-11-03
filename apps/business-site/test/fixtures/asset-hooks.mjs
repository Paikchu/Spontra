// Vite assets the page imports (a font `?url`, stylesheets) resolve to an empty module under the test runner.
const EMPTY = new URL("./empty-asset.mjs", import.meta.url).href;
export async function resolve(specifier, context, next) {
  const path = specifier.split("?")[0];
  if (/\.(?:woff2?|css)$/.test(path)) return { url: EMPTY, format: "module", shortCircuit: true };
  return next(specifier, context);
}
