import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { fixtureApi } from "../../scripts/i18n/fixture-api";
export default defineConfig({root:fileURLToPath(new URL(".",import.meta.url)),plugins:[react(),...(process.env.BUSINESS_SITE_FIXTURES?[fixtureApi()]:[])],resolve:{alias:{"@":fileURLToPath(new URL("../../",import.meta.url))}},build:{outDir:"dist",emptyOutDir:true,rollupOptions:{input:{main:fileURLToPath(new URL("./index.html",import.meta.url)),lens:fileURLToPath(new URL("./lens-frame.html",import.meta.url))}}},server:{host:"127.0.0.1",port:4188,proxy:{"/api":{target:process.env.BUSINESS_SITE_API??"http://127.0.0.1:8788",changeOrigin:true}}},css:{postcss:{plugins:[]}}});
