import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  { files: ["apps/business-site/src/**/*.tsx", "apps/admin/src/**/*.tsx"], rules: { "@next/next/no-html-link-for-pages": "off" } },
  // Business-site text is localized: words a reader sees come from a messages() table, never from a JSX literal.
  // Key caps (<kbd>) and symbols are exempt; data and AI-written text arrive as expressions, not literals.
  {
    files: ["apps/business-site/src/**/*.tsx", "packages/web/src/{sec-report,report,business-flow}/**/*.tsx"],
    rules: {
      "no-restricted-syntax": ["error",
        { selector: "JSXElement[openingElement.name.name!='kbd'] > JSXText[value=/[A-Za-z]{2,}/]", message: "Reader-facing text goes through messages() from packages/web/src/i18n." },
        { selector: "JSXAttribute[name.name=/^(aria-label|title|placeholder|alt|aria-description)$/] > Literal[value=/[A-Za-z]{2,}/]", message: "Reader-facing text goes through messages() from packages/web/src/i18n." },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "apps/business-site/dist/**",
    "apps/admin/dist/**",
    "apps/admin/.wrangler/**",
    "apps/business-site/.wrangler/**",
  ]),
]);

export default eslintConfig;
