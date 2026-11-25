import { parentPort, workerData } from "node:worker_threads";
import { analyzeFiles, type AnalyzerFile } from "./analyze-files";
import { graphIsValid } from "@z1n/contracts";

(async () => {
  try {
    const input = workerData as AnalyzerFile[];
    const graph = await analyzeFiles(input, (stage) =>
      parentPort?.postMessage({ progress: stage }),
    );
    parentPort?.postMessage({ progress: "validating" });
    if (!graphIsValid(graph, input)) throw new Error("Invalid graph evidence");
    parentPort?.postMessage({ graph });
  } catch {
    parentPort?.postMessage({
      error: "Analysis could not be completed for this selection.",
    });
  }
})();
