import { describe, expect, it } from "vitest";
import type { CodeGraph } from "@z1n/contracts";
import { createSemanticIndex } from "./semantic-index";

const files = [{ path: "src/auth.ts", content: "export const auth = 1;" }];
const graph: CodeGraph = {
  nodes: [
    { id: "src/auth.ts", path: "src/auth.ts", exports: [] },
    {
      id: "src/auth.ts#1",
      path: "src/auth.ts",
      name: "authenticate",
      kind: "function",
      startLine: 1,
      endLine: 1,
      exports: [],
    },
  ],
  edges: [],
  evidence: [],
  unresolved: 0,
  unresolvedCalls: 0,
  notice: "",
};

/** A deterministic stand-in embedder: text length drives the vector. */
function fakeEmbedder(): (
  texts: string[],
  options: Record<string, unknown>,
) => Promise<{ data: Float32Array; dims: number[] }> {
  return async (texts) => ({
    data: new Float32Array(texts.flatMap((text) => [text.length, 1])),
    dims: [texts.length, 2],
  });
}

describe("semantic index reliability", () => {
  it("builds and searches with an injected embedder", async () => {
    const index = await createSemanticIndex(files, graph, {
      loadEmbedder: async () => fakeEmbedder(),
    });
    expect(index.available).toBe(true);
    const hits = await index.search("authenticate", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].nodeId).toBe("src/auth.ts#1");
  });
  it("reports an unavailable index when the model loader fails", async () => {
    const index = await createSemanticIndex(files, graph, {
      loadEmbedder: async () => null,
    });
    expect(index.available).toBe(false);
    expect(await index.search("anything", 5)).toEqual([]);
  });
  it("propagates cancellation so a build can be retried", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createSemanticIndex(files, graph, {
        loadEmbedder: async () => fakeEmbedder(),
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/i);
  });
});
