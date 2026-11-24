import { Worker } from "node:worker_threads";
import type { CodeGraph } from "@z1n/contracts";
import type { AnalyzerFile, AnalysisStage } from "@z1n/analysis-core";

type WorkerResponse = {
  graph?: CodeGraph;
  error?: string;
  progress?: AnalysisStage;
};
export type AnalysisOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (stage: AnalysisStage) => void;
  maxHeapMb?: number;
};
// The worker needs far more memory than the size of the source it analyzes.
// The heap is sized for the largest selection the contracts permit, and the
// timeout is a backstop well above the slowest selection measured.
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_HEAP_MB = 1_024;
export class AnalysisError extends Error {}
export function runAnalysis(
  files: AnalyzerFile[],
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    onProgress,
    maxHeapMb = DEFAULT_MAX_HEAP_MB,
  }: AnalysisOptions = {},
): Promise<CodeGraph> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AnalysisError("Analysis was cancelled."));
      return;
    }
    const worker = new Worker(require.resolve("@z1n/analysis-core/worker"), {
      workerData: files,
      resourceLimits: { maxOldGenerationSizeMb: maxHeapMb, stackSizeMb: 4 },
    });
    let settled = false;
    const finish = (error?: Error, graph?: CodeGraph) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      void worker.terminate();
      if (error || !graph)
        reject(error ?? new AnalysisError("Analysis did not return a graph."));
      else resolve(graph);
    };
    const cancel = () => finish(new AnalysisError("Analysis was cancelled."));
    const timer = setTimeout(
      () => finish(new AnalysisError("Analysis exceeded the time limit.")),
      timeoutMs,
    );
    signal?.addEventListener("abort", cancel, { once: true });
    worker.on("message", (message: WorkerResponse) => {
      if (message.progress) {
        if (!settled) onProgress?.(message.progress);
        return;
      }
      finish(
        message.error ? new AnalysisError(message.error) : undefined,
        message.graph,
      );
    });
    worker.once("error", (error) =>
      finish(
        new AnalysisError(
          (error as NodeJS.ErrnoException).code === "ERR_WORKER_OUT_OF_MEMORY"
            ? "The selection exceeded the memory available for analysis. Analyze fewer or smaller files."
            : "The analysis worker failed.",
        ),
      ),
    );
    worker.once("exit", () =>
      finish(
        new AnalysisError(
          "The analysis worker exited before returning a result.",
        ),
      ),
    );
  });
}
