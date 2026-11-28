/// <reference lib="webworker" />
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";

/**
 * Bounded ForceAtlas2 refinement worker for the workspace renderer.
 *
 * The graph arrives as flat arrays (ids, edge endpoint index pairs, seeded
 * positions and sizes), is rebuilt as a graphology multigraph here, and is
 * refined in chunks so intermediate positions stream back to the renderer.
 * The run is bounded by a wall-clock budget and stops early on a "stop"
 * message; the supervisor terminates the worker on completion, graph
 * replacement and unmount, so no worker outlives its layout.
 */
type StartMessage = {
  type: "start";
  ids: string[];
  edges: Uint32Array;
  positions: Float32Array;
  sizes: Float32Array;
  settings: Record<string, unknown>;
  budgetMs: number;
  chunkIterations: number;
};
type StopMessage = { type: "stop" };
type Inbound = StartMessage | StopMessage;

let stopped = false;

self.onmessage = (event: MessageEvent<Inbound>) => {
  const message = event.data;
  if (message.type === "stop") {
    stopped = true;
    return;
  }
  if (message.type !== "start") return;
  stopped = false;
  const layout = new Graph({ multi: true, type: "directed" });
  const indexOf = new Map<string, number>();
  message.ids.forEach((id, index) => {
    indexOf.set(id, index);
    layout.addNode(id, {
      x: message.positions[index * 2]!,
      y: message.positions[index * 2 + 1]!,
      size: message.sizes[index] ?? 1,
    });
  });
  for (let index = 0; index < message.edges.length; index += 2) {
    const source = message.ids[message.edges[index]!]!;
    const target = message.ids[message.edges[index + 1]!]!;
    if (layout.hasNode(source) && layout.hasNode(target))
      layout.addEdge(source, target);
  }
  const settings = forceAtlas2.inferSettings(layout);
  const started = performance.now();
  let elapsed = 0;
  while (!stopped && elapsed < message.budgetMs) {
    forceAtlas2.assign(layout, {
      iterations: message.chunkIterations,
      settings: { ...settings, ...message.settings },
    });
    elapsed = performance.now() - started;
    const positions = new Float32Array(layout.order * 2);
    layout.forEachNode((id, attributes) => {
      const index = indexOf.get(id)!;
      positions[index * 2] = attributes.x;
      positions[index * 2 + 1] = attributes.y;
    });
    self.postMessage({ type: "tick", positions }, [positions.buffer]);
  }
  self.postMessage({ type: "done" });
};
