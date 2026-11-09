import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import importPlugin from "eslint-plugin-import";
import jsxA11y from "eslint-plugin-jsx-a11y";
import globals from "globals";

// No Next.js in this repo: the rule set eslint-config-next used to supply (minus its @next/next rules),
// wired directly so lint does not need the `next` package.
const eslintConfig = defineConfig([
  {
    name: "spontra/base",
    files: ["**/*.{js,jsx,mjs,ts,tsx,mts,cts}"],
    plugins: { react, "react-hooks": reactHooks, import: importPlugin, "jsx-a11y": jsxA11y },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { sourceType: "module", ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node },
    },
    settings: { react: { version: "detect" } },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      "import/no-anonymous-default-export": "warn",
      "react/no-unknown-property": "off",
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      "jsx-a11y/alt-text": ["warn", { elements: ["img"], img: ["Image"] }],
      "jsx-a11y/aria-props": "warn",
      "jsx-a11y/aria-proptypes": "warn",
      "jsx-a11y/aria-unsupported-elements": "warn",
      "jsx-a11y/role-has-required-aria-props": "warn",
      "jsx-a11y/role-supports-aria-props": "warn",
      "react/jsx-no-target-blank": "off",
    },
  },
  ...tseslint.configs.recommended.map((c) => ({ ...c, files: c.files ?? ["**/*.ts", "**/*.tsx"] })),
  { files: ["**/*.ts", "**/*.tsx"], rules: { "@typescript-eslint/no-unused-vars": "warn", "@typescript-eslint/no-unused-expressions": "warn" } },
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
  globalIgnores([
    "apps/business-site/dist/**",
    "apps/business-site/dist-desktop/**",
    "apps/desktop/src-tauri/target/**",
    "apps/desktop/src-tauri/gen/**",
    "scripts/desktop-selftest.js",
    "apps/admin/dist/**",
    "apps/admin/.wrangler/**",
    "apps/business-site/.wrangler/**",
  ]),
]);

export default eslintConfig;
