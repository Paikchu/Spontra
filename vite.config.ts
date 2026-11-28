import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: local("./web"),
  publicDir: local("./web/public"),
  plugins: [react()],
  resolve: {
    alias: [{ find: "@", replacement: local("./") }],
  },
  build: {
    outDir: local("./dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        admin: local("./web/admin.html"),
        preview: local("./web/preview.html"),
        "artifact-frame": local("./web/artifact-frame.html"),
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 4190,
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
