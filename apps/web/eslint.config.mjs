import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // These components render user attachments and message images from arbitrary
    // blob:, data: and remote URLs, which next/image cannot optimize. markdown-text.tsx
    // renders https images from model answers; next/image would need a host allowlist,
    // and the model picks the host.
    files: [
      "src/components/image.tsx",
      "src/components/media-player.tsx",
      "src/components/assistant-ui/elements/attachment.aui.tsx",
      "src/components/markdown-text.tsx",
    ],
    rules: { "@next/next/no-img-element": "off" },
  },
  {
    // Interface text lives in the message catalogues (src/i18n/translations, not linted);
    // Russian text or the 'ru-RU' locale in code means a phrase escaped them.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/**/*.test.{ts,tsx}", "src/test/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/[А-Яа-яЁё]/]",
          message: "Interface text belongs in the message catalogue (src/i18n/translations).",
        },
        {
          selector: "TemplateElement[value.raw=/[А-Яа-яЁё]/]",
          message: "Interface text belongs in the message catalogue (src/i18n/translations).",
        },
        {
          selector: "JSXText[value=/[А-Яа-яЁё]/]",
          message: "Interface text belongs in the message catalogue (src/i18n/translations).",
        },
        {
          selector: "Literal[value='ru-RU']",
          message: "Take the locale from useLocale() or useFormatter(), not 'ru-RU'.",
        },
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
  ]),
]);

export default eslintConfig;
