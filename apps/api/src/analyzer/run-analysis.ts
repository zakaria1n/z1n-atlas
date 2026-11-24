import { Worker } from "node:worker_threads";
import type { CodeGraph } from "@z1n/contracts";
import type { AnalyzerFile } from "@z1n/analysis-core";

type WorkerResponse = { graph?: CodeGraph; error?: string };
export class AnalysisError extends Error {}
export function runAnalysis(
  files: AnalyzerFile[],
  timeoutMs = 15_000,
  signal?: AbortSignal,
): Promise<CodeGraph> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AnalysisError("Analysis was cancelled."));
      return;
    }
    const worker = new Worker(require.resolve("@z1n/analysis-core/worker"), {
      workerData: files,
      resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 },
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
    worker.once("message", (message: WorkerResponse) =>
      finish(
        message.error ? new AnalysisError(message.error) : undefined,
        message.graph,
      ),
    );
    worker.once("error", () =>
      finish(new AnalysisError("The analysis worker failed.")),
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
