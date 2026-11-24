import { randomUUID } from "node:crypto";
import type { AnalysisJob, CodeGraph } from "@z1n/contracts";
import type { AnalysisStage } from "@z1n/analysis-core";
import { AnalysisError } from "./run-analysis";
type Entry = {
  state: AnalysisJob;
  abort: AbortController;
  timer: ReturnType<typeof setTimeout>;
};
type Task = (
  signal: AbortSignal,
  progress: (stage: AnalysisStage) => void,
) => Promise<CodeGraph>;
export function createAnalysisJobs({ maxEntries = 4, ttlMs = 300_000 } = {}) {
  const jobs = new Map<string, Entry>();
  function remove(id: string) {
    const entry = jobs.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      entry.abort.abort();
    }
    jobs.delete(id);
  }
  return {
    start(task: Task, done: () => void): string | undefined {
      if (jobs.size >= maxEntries) {
        const finished = [...jobs].find(
          ([, entry]) => entry.state.status !== "running",
        );
        if (!finished) return undefined;
        remove(finished[0]);
      }
      const id = randomUUID();
      const abort = new AbortController();
      const timer = setTimeout(() => remove(id), ttlMs);
      timer.unref();
      const entry: Entry = {
        state: { status: "running", stage: "parsing" },
        abort,
        timer,
      };
      jobs.set(id, entry);
      void Promise.resolve()
        .then(() =>
          task(abort.signal, (stage) => {
            if (entry.state.status === "running")
              entry.state = { status: "running", stage };
          }),
        )
        .then((graph) => {
          if (entry.state.status === "running")
            entry.state = { status: "complete", graph };
        })
        .catch((error: unknown) => {
          if (entry.state.status === "running")
            entry.state = {
              status: "failed",
              error:
                error instanceof AnalysisError
                  ? error.message
                  : "Analysis could not be completed within the available resources.",
            };
        })
        .finally(done);
      return id;
    },
    get(id: string): AnalysisJob | undefined {
      return jobs.get(id)?.state;
    },
    cancel(id: string): boolean {
      const entry = jobs.get(id);
      if (!entry) return false;
      if (entry.state.status === "running") {
        entry.state = { status: "cancelled" };
        entry.abort.abort();
      } else remove(id);
      return true;
    },
    clear() {
      for (const id of jobs.keys()) remove(id);
    },
  };
}
