import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
// Only the explicit `pnpm test:llm:live` command uses this configuration, so
// the opt-in live provider suite never runs as part of `pnpm test`.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)) },
  },
  test: { exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"] },
});
