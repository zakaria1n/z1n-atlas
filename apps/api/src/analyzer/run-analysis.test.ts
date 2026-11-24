import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { runAnalysis as RunAnalysis } from "./run-analysis";
const require = createRequire(import.meta.url);
const { runAnalysis } = require("../../dist/analyzer/run-analysis.js") as {
  runAnalysis: typeof RunAnalysis;
};
const source = [{ path: "a.ts", content: "export const a = 1;" }];
describe("isolated analysis", () => {
  it("returns verified relationships from the compiled Node worker", async () => {
    const stages: string[] = [];
    const graph = await runAnalysis(
      [
        { path: "src/index.ts", content: 'import {x} from "./util";' },
        { path: "src/util.ts", content: "export const x = 1;" },
      ],
      { onProgress: (stage) => stages.push(stage) },
    );
    expect(stages).toEqual([
      "parsing",
      "imports",
      "symbols",
      "frameworks",
      "validating",
    ]);
    expect(graph.edges.filter((e) => e.kind === "imports")).toHaveLength(1);
    expect(graph.evidence[0]).toMatchObject({
      filePath: "src/index.ts",
      startLine: 1,
    });
  }, 20000);
  it("terminates a worker exceeding its deadline", async () => {
    await expect(runAnalysis(source, { timeoutMs: 1 })).rejects.toThrow(
      "time limit",
    );
  });
  it("terminates a worker when the caller cancels", async () => {
    const controller = new AbortController();
    const result = runAnalysis(source, { signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toThrow("cancelled");
  });
  it("reports a worker that runs out of memory", async () => {
    await expect(runAnalysis(source, { maxHeapMb: 8 })).rejects.toThrow(
      "exceeded the memory available for analysis",
    );
  });
});
