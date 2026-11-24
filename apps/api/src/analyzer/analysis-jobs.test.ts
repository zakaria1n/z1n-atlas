import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeGraph } from "@z1n/contracts";
import { createAnalysisJobs } from "./analysis-jobs";
const graph: CodeGraph = {
  nodes: [],
  edges: [],
  evidence: [],
  unresolved: 0,
  unresolvedCalls: 0,
  notice: "",
};
afterEach(() => vi.useRealTimers());
describe("bounded analysis jobs", () => {
  it("reports worker stages and returns the completed graph", async () => {
    const jobs = createAnalysisJobs();
    let finish!: (graph: CodeGraph) => void;
    const done = vi.fn();
    const id = jobs.start((_signal, progress) => {
      progress("symbols");
      return new Promise((resolve) => {
        finish = resolve;
      });
    }, done)!;
    await Promise.resolve();
    expect(jobs.get(id)).toEqual({ status: "running", stage: "symbols" });
    finish(graph);
    await vi.waitFor(() => expect(jobs.get(id)?.status).toBe("complete"));
    expect(done).toHaveBeenCalledOnce();
    expect(jobs.cancel(id)).toBe(true);
    expect(jobs.get(id)).toBeUndefined();
    jobs.clear();
  });
  it("bounds active jobs, propagates cancellation and expires retained results", async () => {
    vi.useFakeTimers();
    const jobs = createAnalysisJobs({ maxEntries: 1, ttlMs: 100 });
    let signal!: AbortSignal;
    const id = jobs.start(
      async (value) => {
        signal = value;
        return new Promise<CodeGraph>(() => {});
      },
      () => {},
    )!;
    await Promise.resolve();
    expect(
      jobs.start(
        async () => graph,
        () => {},
      ),
    ).toBeUndefined();
    expect(jobs.cancel(id)).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(jobs.get(id)).toEqual({ status: "cancelled" });
    vi.advanceTimersByTime(100);
    expect(jobs.get(id)).toBeUndefined();
    jobs.clear();
  });
});
