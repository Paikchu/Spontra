/** Vite resolves `?url` imports to the built asset's public path. */
declare module "*?url" { const url: string; export default url; }
