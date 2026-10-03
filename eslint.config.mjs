import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  { files: ["apps/business-site/src/**/*.tsx", "apps/admin/src/**/*.tsx"], rules: { "@next/next/no-html-link-for-pages": "off" } },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "apps/desktop/dist/**",
    "apps/business-site/dist/**",
    "apps/admin/dist/**",
    "apps/admin/.wrangler/**",
    "apps/business-site/.wrangler/**",
    "apps/desktop/src-tauri/**",
  ]),
]);

export default eslintConfig;
