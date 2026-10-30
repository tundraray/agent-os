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
