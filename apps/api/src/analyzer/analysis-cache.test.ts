import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnalysisCache } from "./analysis-cache";
const files = [{ path: "a.ts", content: "export const a = 1;" }];
const graph = {
  nodes: [],
  edges: [],
  evidence: [],
  unresolved: 0,
  unresolvedCalls: 0,
  notice: "",
};
afterEach(() => vi.useRealTimers());
describe("analysis session cache", () => {
  it("only returns the graph for the exact source selection and opaque ID", () => {
    const cache = createAnalysisCache();
    const id = cache.put(files, graph);
    expect(cache.get(id, files)).toBe(graph);
    expect(
      cache.get(id, [{ ...files[0], content: "changed" }]),
    ).toBeUndefined();
    expect(cache.get("unknown", files)).toBeUndefined();
    cache.clear();
    expect(cache.get(id, files)).toBeUndefined();
  });
  it("expires and bounds the number and size of entries", () => {
    vi.useFakeTimers();
    const cache = createAnalysisCache({
      maxEntries: 1,
      maxBytes: 1000,
      ttlMs: 100,
    });
    const first = cache.put(files, graph);
    const second = cache.put(files, graph);
    expect(cache.get(first, files)).toBeUndefined();
    expect(cache.get(second, files)).toBe(graph);
    vi.advanceTimersByTime(100);
    expect(cache.get(second, files)).toBeUndefined();
    expect(
      createAnalysisCache({ maxEntries: 1, maxBytes: 1, ttlMs: 100 }).put(
        files,
        graph,
      ),
    ).toBeUndefined();
  });
});
