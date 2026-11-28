import Graph from "graphology";
import type { CodeGraph, GraphNode } from "@z1n/contracts";

/**
 * CodeGraph → graphology multigraph for the Sigma workspace renderer.
 *
 * The repository's CodeGraph contract stays the authoritative representation:
 * node and edge identities are the graphology keys, edge kinds and confidence
 * are retained as attributes, and parallel edges between the same endpoints
 * are never collapsed. Positions are seeded deterministically — files on a
 * golden-angle ring, symbols jittered near their file by a per-node seeded
 * generator — so reloads and repository switches reproduce the same starting
 * layout for the ForceAtlas2 refinement.
 */
export type GraphologyGraph = Graph<SigmaNodeAttributes, SigmaEdgeAttributes>;

export type SigmaNodeAttributes = {
  label: string;
  x: number;
  y: number;
  size: number;
  color: string;
  kind: string;
  path: string;
  startLine?: number;
};

export type SigmaEdgeAttributes = {
  kind: string;
  confidence: string;
  curvature: number;
};

// The approved identity palette: cobalt nodes and edges, amber for heuristic
// confidence, coral-orange for an active journey highlight.
export const NODE_COLOR = "#2563eb";
export const HEURISTIC_EDGE_COLOR = "#b45309";
export const EDGE_COLOR = "#2563eb";
export const JOURNEY_COLOR = "#c2410c";
const IVORY = [250, 247, 242];

const KIND_SIZE: Record<string, number> = {
  file: 5,
  route: 5,
  entrypoint: 5,
  class: 3.5,
  "http-call": 3,
  database: 3,
  function: 2.5,
  method: 2.5,
};

/** Mix a hex color toward the ivory background; amount 0 keeps the color. */
export function mixWithBackground(hex: string, amount: number): string {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!match) return hex;
  const channels = [1, 2, 3].map((group) =>
    Math.round(
      Number.parseInt(match[group]!, 16) * (1 - amount) +
        IVORY[group - 1]! * amount,
    ),
  );
  return `#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function hashSeed(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export function codeGraphToGraphology(graph: CodeGraph): GraphologyGraph {
  const layout = new Graph<SigmaNodeAttributes, SigmaEdgeAttributes>({
    multi: true,
    type: "directed",
  });
  const fileNodes = graph.nodes.filter(
    (node) => !node.kind || node.kind === "file",
  );
  const spread = 40 * Math.sqrt(Math.max(fileNodes.length, 1));
  const positions = new Map<string, { x: number; y: number }>();
  fileNodes.forEach((node, index) => {
    const angle = index * GOLDEN_ANGLE;
    const radius = spread * Math.sqrt((index + 1) / fileNodes.length);
    positions.set(node.id, {
      x: radius * Math.cos(angle),
      y: radius * Math.sin(angle),
    });
  });
  for (const node of graph.nodes) addNode(layout, node, positions, spread);
  // Parallel edges get a deterministic curvature offset so distinct
  // relationships between identical endpoints remain visually separable.
  const parallelIndex = new Map<string, number>();
  for (const edge of graph.edges) {
    if (!layout.hasNode(edge.source) || !layout.hasNode(edge.target)) continue;
    if (layout.hasEdge(edge.id)) continue;
    const pair = `${edge.source}\u0000${edge.target}`;
    const rank = parallelIndex.get(pair) ?? 0;
    parallelIndex.set(pair, rank + 1);
    layout.addEdgeWithKey(edge.id, edge.source, edge.target, {
      kind: edge.kind,
      confidence: edge.confidence,
      curvature:
        (rank % 2 === 0 ? 1 : -1) * (0.08 + Math.floor(rank / 2) * 0.06),
    });
  }
  return layout;
}

function addNode(
  layout: GraphologyGraph,
  node: GraphNode,
  positions: Map<string, { x: number; y: number }>,
  spread: number,
): void {
  if (layout.hasNode(node.id)) return;
  let position = positions.get(node.id);
  if (!position) {
    // A symbol is seeded near its file so refinement starts from short edges.
    const parent = positions.get(node.path);
    const jitter = mulberry32(hashSeed(node.id));
    const base = parent ?? { x: 0, y: 0 };
    const reach = parent ? spread * 0.05 : spread * 0.4;
    position = {
      x: base.x + (jitter() - 0.5) * 2 * reach,
      y: base.y + (jitter() - 0.5) * 2 * reach,
    };
    positions.set(node.id, position);
  }
  layout.addNode(node.id, {
    label: node.name ?? node.path.split("/").pop() ?? node.path,
    x: position.x,
    y: position.y,
    size: KIND_SIZE[node.kind ?? "file"] ?? 4,
    color: NODE_COLOR,
    kind: node.kind ?? "file",
    path: node.path,
    startLine: node.startLine,
  });
}
