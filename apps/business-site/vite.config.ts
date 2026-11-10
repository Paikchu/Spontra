import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { fixtureApi } from "../../scripts/i18n/fixture-api";
import { DEFAULT_SITE_ORIGIN, desktopShell } from "./desktop-shell.vite";

const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig(({ mode }) => {
  const desktop = mode === "desktop";
  const siteOrigin = process.env.SPONTRA_SITE_ORIGIN ?? DEFAULT_SITE_ORIGIN;
  return {
    root: local("."),
    plugins: [
      react(),
      ...(desktop ? [babel({ presets: [reactCompilerPreset()] }), desktopShell(siteOrigin)] : []),
      ...(process.env.BUSINESS_SITE_FIXTURES ? [fixtureApi()] : []),
    ],
    resolve: {
      alias: [
        ...(desktop ? [{ find: /^\.\/socket-options$/, replacement: local("./src/desktop/stage-socket.ts") }] : []),
        { find: "@", replacement: local("../../") },
      ],
    },
    define: desktop ? { __SPONTRA_SITE_HOST__: JSON.stringify(new URL(siteOrigin).host) } : {},
    build: {
      outDir: desktop ? "dist-desktop" : "dist",
      emptyOutDir: true,
      // The desktop app runs on the system webview only: WKWebView on macOS and WebView2 on Windows.
      ...(desktop ? { target: ["safari17", "chrome120"], modulePreload: { polyfill: false } } : {}),
      rollupOptions: { input: { main: local("./index.html"), lens: local("./lens-frame.html"), artifact: local("./artifact-frame.html") } },
    },
    server: { host: "127.0.0.1", port: 4188, proxy: { "/api": { target: process.env.BUSINESS_SITE_API ?? "http://127.0.0.1:8788", changeOrigin: true } } },
    css: { postcss: { plugins: [] } },
  };
});
