import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({root:fileURLToPath(new URL(".",import.meta.url)),plugins:[react()],resolve:{alias:{"@":fileURLToPath(new URL("../../",import.meta.url))}},build:{outDir:"dist",emptyOutDir:true},server:{host:"127.0.0.1",port:4188,proxy:{"/api":process.env.BUSINESS_SITE_API??"http://127.0.0.1:8788"}},css:{postcss:{plugins:[]}}});
