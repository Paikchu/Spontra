import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
function desktopBoundary(): Plugin {
  return { name: "desktop-server-boundary", enforce: "pre", load(id) {
    const clean = id.split("?")[0].replaceAll("\\", "/");
    if (/cloudflare:|(?:^|\/)db\/|\/workers\/|\/data\/portfolio-snapshot\.json$|\/lib\/(?:site-data|.*-store|.*-runtime|stock-context|research-backend)\.ts$/.test(clean)) {
      throw new Error(`Server-only module in desktop bundle: ${id}`);
    }
  }};
}
export default defineConfig({
  plugins: [desktopBoundary(), react()],
  resolve: { alias: { "@": root } },
  publicDir: `${root}/public`,
  server: { host: "127.0.0.1", port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: { target: ["es2022", "safari15"], sourcemap: false },
});
