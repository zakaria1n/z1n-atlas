import { describe, expect, it, vi } from "vitest";
import { createFa2Supervisor, type Fa2WorkerLike } from "./use-fa2-layout";

function stubWorker() {
  const sent: unknown[] = [];
  const worker: Fa2WorkerLike = {
    onmessage: null,
    postMessage: (message) => {
      sent.push(message);
    },
    terminate: vi.fn(() => {
      worker.onmessage = null;
    }),
  };
  return { worker, sent };
}

const payload = {
  ids: ["a", "b"],
  edges: new Uint32Array([0, 1]),
  positions: new Float32Array([0, 0, 1, 1]),
  sizes: new Float32Array([5, 2.5]),
  settings: { gravity: 1 },
  budgetMs: 4000,
  chunkIterations: 8,
};

describe("fa2 supervisor lifecycle", () => {
  it("sends the start payload and applies ticks", () => {
    const first = stubWorker();
    const onTick = vi.fn();
    const supervisor = createFa2Supervisor({
      createWorker: () => first.worker,
    });
    supervisor.start(payload, { onTick, onDone: () => {} });
    expect(first.sent[0]).toMatchObject({ type: "start", ids: ["a", "b"] });
    first.worker.onmessage?.({
      data: { type: "tick", positions: new Float32Array(4) },
    });
    expect(onTick).toHaveBeenCalledOnce();
    expect(supervisor.isRunning).toBe(true);
  });

  it("terminates the worker when the done message arrives", () => {
    const first = stubWorker();
    const done = vi.fn();
    const supervisor = createFa2Supervisor({
      createWorker: () => first.worker,
    });
    supervisor.start(payload, { onTick: () => {}, onDone: done });
    first.worker.onmessage?.({ data: { type: "done" } });
    expect(done).toHaveBeenCalledOnce();
    expect(supervisor.isRunning).toBe(false);
    expect(first.worker.terminate).toHaveBeenCalled();
  });

  it("kills the previous worker when a layout replaces it", () => {
    const first = stubWorker();
    const second = stubWorker();
    let next = first.worker;
    const supervisor = createFa2Supervisor({
      createWorker: () => {
        const current = next;
        next = second.worker;
        return current;
      },
    });
    supervisor.start(payload, { onTick: () => {}, onDone: () => {} });
    supervisor.start(payload, { onTick: () => {}, onDone: () => {} });
    expect(first.worker.terminate).toHaveBeenCalled();
    expect(second.sent[0]).toMatchObject({ type: "start" });
    expect(supervisor.isRunning).toBe(true);
  });

  it("kills immediately on kill() and stays inert afterwards", () => {
    const first = stubWorker();
    const supervisor = createFa2Supervisor({
      createWorker: () => first.worker,
    });
    supervisor.start(payload, { onTick: () => {}, onDone: () => {} });
    supervisor.kill();
    expect(first.worker.terminate).toHaveBeenCalled();
    expect(supervisor.isRunning).toBe(false);
    // A late tick after kill must not reach the renderer.
    const onTick = vi.fn();
    supervisor.start(payload, { onTick, onDone: () => {} });
    supervisor.kill();
    first.worker.onmessage?.({
      data: { type: "tick", positions: new Float32Array(4) },
    });
    expect(onTick).not.toHaveBeenCalled();
  });

  it("stop() asks the worker to finish and only signals once", () => {
    const first = stubWorker();
    const done = vi.fn();
    const supervisor = createFa2Supervisor({
      createWorker: () => first.worker,
    });
    supervisor.start(payload, { onTick: () => {}, onDone: done });
    supervisor.stop();
    expect(first.sent.at(-1)).toMatchObject({ type: "stop" });
    first.worker.onmessage?.({ data: { type: "done" } });
    supervisor.stop();
    first.worker.onmessage?.({ data: { type: "done" } });
    expect(done).toHaveBeenCalledOnce();
  });
});
