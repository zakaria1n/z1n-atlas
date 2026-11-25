import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)) },
  },
  test: {
    // The opt-in live provider suite only runs through `pnpm test:llm:live`
    // with its own configuration, so billable requests stay behind an
    // explicit command even when RUN_LIVE_LLM_TESTS is set in apps/api/.env.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/src/live/**",
    ],
  },
});
