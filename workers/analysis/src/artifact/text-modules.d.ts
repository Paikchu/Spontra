/** Stylesheets and scripts bundled as text (the "Text" rule in wrangler.jsonc). */
declare module "*.css" { const text: string; export default text; }
declare module "axe-core/axe.min.js" { const text: string; export default text; }
