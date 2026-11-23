import path from "node:path";
import { Worker } from "node:worker_threads";
import type { CodeGraph } from "../../core/graph/contracts";
import type { AnalyzerFile } from "./analyze-files";

type WorkerResponse = { graph?: CodeGraph; error?: string };
export class AnalysisError extends Error {}
export function runAnalysis(
  files: AnalyzerFile[],
  timeoutMs = 15_000,
): Promise<CodeGraph> {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(
      process.cwd(),
      ".analysis-build/server/analyzer/worker.js",
    );
    // Keep the compiled Node worker and its input separate from Next.js worker bundling.
    const worker: Worker = Reflect.construct(Worker, [
      workerPath,
      {
        workerData: files,
        resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 },
      },
    ]);
    let settled = false;
    const finish = (error?: Error, graph?: CodeGraph) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error || !graph)
        reject(error ?? new AnalysisError("Analysis did not return a graph."));
      else resolve(graph);
    };
    const timer = setTimeout(
      () => finish(new AnalysisError("Analysis exceeded the time limit.")),
      timeoutMs,
    );
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
