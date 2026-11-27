import { describe, expect, it } from "vitest";
import type { CodeGraph } from "@z1n/contracts";
import { createSnapshotCache } from "./snapshot-cache";

const filesA = [{ path: "a.ts", content: "export const a = 1;" }];
const filesB = [{ path: "a.ts", content: "export const a = 2;" }];
const graph: CodeGraph = {
  nodes: [{ id: "a.ts", path: "a.ts", exports: [] }],
  edges: [],
  evidence: [],
  unresolved: 0,
  unresolvedCalls: 0,
  notice: "",
};

describe("repository snapshot cache", () => {
  it("reuses the identical snapshot for identical source content", () => {
    const cache = createSnapshotCache();
    const first = cache.obtain(filesA, graph);
    const second = cache.obtain(filesA, graph);
    expect(second).toBe(first);
    expect(cache.size).toBe(1);
    expect(first.lexical.search("a", 5).length).toBeGreaterThan(0);
  });
  it("builds a fresh snapshot when any source byte changes", () => {
    const cache = createSnapshotCache();
    const before = cache.obtain(filesA, graph);
    const after = cache.obtain(filesB, graph);
    expect(after).not.toBe(before);
    expect(after.identity).not.toBe(before.identity);
    expect(cache.size).toBe(2);
  });
  it("evicts the oldest snapshot beyond the entry bound", () => {
    const cache = createSnapshotCache({ maxEntries: 2 });
    const first = cache.obtain([{ path: "x.ts", content: "1" }], graph);
    cache.obtain([{ path: "x.ts", content: "2" }], graph);
    cache.obtain([{ path: "x.ts", content: "3" }], graph);
    expect(cache.size).toBe(2);
    // The evicted identity builds a fresh snapshot on next use.
    expect(cache.obtain([{ path: "x.ts", content: "1" }], graph)).not.toBe(
      first,
    );
  });
  it("clear drops every snapshot", () => {
    const cache = createSnapshotCache();
    cache.obtain(filesA, graph);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
