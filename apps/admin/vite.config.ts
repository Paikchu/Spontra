import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: false,
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("../../", import.meta.url)) } },
  build: { outDir: "dist", emptyOutDir: true },
  server: { host: "127.0.0.1", port: 4190, proxy: { "/api": "http://127.0.0.1:8790" } },
});
