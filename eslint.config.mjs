import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  { settings: { react: { version: "19.0" }, next: { rootDir: "apps/web/" } } },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    "**/.next/**",
    "**/dist/**",
    "**/node_modules/**",
    ".analysis-build/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored MIT library copies (graphology-layout-forceatlas2) loaded by
    // Synthetic projects that exercise the analyzer, kept verbatim as test data.
    "fixtures/**",
  ]),
]);

export default eslintConfig;
