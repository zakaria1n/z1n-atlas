import { parentPort, workerData } from "node:worker_threads";
import { analyzeFiles, type AnalyzerFile } from "./analyze-files";
import { graphIsValid } from "../../core/graph/validate-graph";

try {
  const input = workerData as AnalyzerFile[];
  const graph = analyzeFiles(input);
  if (!graphIsValid(graph, input)) throw new Error("Invalid graph evidence");
  parentPort?.postMessage({ graph });
} catch {
  parentPort?.postMessage({
    error: "Analysis could not be completed for this selection.",
  });
}
