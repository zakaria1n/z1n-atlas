/**
 * Supervisor for the bounded ForceAtlas2 refinement worker.
 *
 * Mirrors the reference renderer's lifecycle guarantees: the worker is
 * terminated (not merely stopped) when the layout completes, when a new
 * layout replaces the old one, when the repository changes and when the
 * component unmounts. The worker factory is injectable so lifecycle tests
 * can drive the supervisor with a stub worker.
 */
export type Fa2WorkerLike = {
  postMessage: (message: unknown, transfer?: unknown) => void;
  terminate: () => void;
  onmessage: ((event: { data: unknown }) => void) | null;
};

export type Fa2StartPayload = {
  ids: string[];
  edges: Uint32Array;
  positions: Float32Array;
  sizes: Float32Array;
  settings: Record<string, unknown>;
  budgetMs: number;
  chunkIterations: number;
};

export type Fa2SupervisorLike = ReturnType<typeof createFa2Supervisor>;

export function createFa2Supervisor({
  createWorker,
}: {
  createWorker: () => Fa2WorkerLike;
}) {
  let worker: Fa2WorkerLike | null = null;
  let running = false;
  return {
    get isRunning() {
      return running;
    },
    start(
      payload: Fa2StartPayload,
      handlers: {
        onTick: (positions: Float32Array) => void;
        onDone: () => void;
      },
    ): void {
      // A replaced layout must never leave the previous worker alive.
      this.kill();
      worker = createWorker();
      worker.onmessage = (event) => {
        const data = event.data as
          { type: "tick"; positions: Float32Array } | { type: "done" };
        if (data.type === "tick") handlers.onTick(data.positions);
        else if (data.type === "done") {
          running = false;
          this.kill();
          handlers.onDone();
        }
      };
      running = true;
      worker.postMessage({ type: "start", ...payload });
    },
    /** Ask the worker to finish its chunk loop, then terminate on its reply. */
    stop(): void {
      if (!worker) return;
      worker.postMessage({ type: "stop" });
    },
    /** Immediate termination: unmount, repository switch or failure path. */
    kill(): void {
      worker?.terminate();
      worker = null;
      running = false;
    },
  };
}
