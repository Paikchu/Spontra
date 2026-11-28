import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: local("."),
  plugins: [react()],
  resolve: {
    alias: [{ find: "@", replacement: local("../../") }],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: { input: { main: local("./index.html"), artifact: local("./artifact-frame.html") } },
  },
  server: { host: "127.0.0.1", port: 4188, proxy: { "/api": { target: process.env.BUSINESS_SITE_API ?? "http://127.0.0.1:8788", changeOrigin: true } } },
  css: { postcss: { plugins: [] } },
});
