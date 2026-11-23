import { describe, expect, it } from "vitest";
import { runAnalysis } from "./run-analysis";

describe("isolated analysis", () => {
  it("returns verified relationships from the actual Node worker", async () => {
    const graph = await runAnalysis([
      { path: "src/index.ts", content: 'import {x} from "./util";' },
      { path: "src/util.ts", content: "export const x = 1;" },
    ]);
    expect(graph.edges).toHaveLength(1);
    expect(graph.evidence[0]).toMatchObject({
      filePath: "src/index.ts",
      startLine: 1,
    });
  }, 20000);
  it("terminates a worker that exceeds its deadline", async () => {
    await expect(
      runAnalysis([{ path: "a.ts", content: "export const a = 1;" }], 1),
    ).rejects.toThrow("time limit");
  });
});
