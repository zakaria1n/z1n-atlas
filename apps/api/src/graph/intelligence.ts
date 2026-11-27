import type { CodeGraph } from "@z1n/contracts";
import type { GraphAdapter } from "./adapter";

// Static process detection budgets: bounded depth, branching and count so a
// large graph can never produce unbounded traversals. Every reached cap is
// reported as truncation, never silently dropped.
const MAX_DEPTH = 10;
const MAX_BRANCHING = 4;
const MAX_PROCESSES = 75;
const MIN_STEPS = 2;
const MAX_ENTRY_CANDIDATES = 200;

export type EntryPoint = {
  nodeId: string;
  score: number;
  reasons: string[];
};

export type StaticProcess = {
  nodeIds: string[];
  label: string;
};

export type GraphIntelligence = {
  /** Structural entry-point ranking; a heuristic, not proof of usage. */
  entryPoints: EntryPoint[];
  /** Bounded static call paths from ranked entry points; not runtime traces. */
  processes: StaticProcess[];
  /** Connected components over relationship edges; structural groupings. */
  communities: string[][];
  truncatedProcesses: boolean;
  truncatedEntryCandidates: boolean;
};

const ENTRY_NAME_PATTERNS: RegExp[] = [
  /^handle[A-Z]/,
  /Controller$/,
  /^(main|index|server|app|bootstrap|start)$/i,
  /^on[A-Z]/,
  /Handler$/,
  /^(get|post|put|patch|delete)[A-Z]/,
];
const UTILITY_NAME_PATTERNS: RegExp[] = [
  /^(util|helper|format|parse|stringify)/i,
];

/**
 * Structural entry-point scoring after the reference mechanism: outgoing
 * over incoming calls, boosted for entry-shaped names and path locations.
 * Names and degrees are heuristics — the score ranks candidates, it does
 * not prove anything runs.
 */
export function entryPointScores(
  graph: CodeGraph,
  adapter: GraphAdapter,
): EntryPoint[] {
  const scored: EntryPoint[] = [];
  let candidateCount = 0;
  for (const node of graph.nodes) {
    if (!node.kind || node.kind === "file") continue;
    if (candidateCount >= MAX_ENTRY_CANDIDATES) {
      break;
    }
    const outbound = adapter.outbound(node.id).length;
    const inbound = adapter.inbound(node.id).length;
    if (outbound === 0) continue;
    candidateCount += 1;
    const name = node.name ?? "";
    const reasons: string[] = [];
    let score = outbound / (inbound + 1);
    if (inbound === 0) {
      score *= 2;
      reasons.push("no incoming callers");
    }
    if (ENTRY_NAME_PATTERNS.some((pattern) => pattern.test(name))) {
      score *= 1.5;
      reasons.push("entry-shaped name");
    }
    if (UTILITY_NAME_PATTERNS.some((pattern) => pattern.test(name))) {
      score *= 0.3;
      reasons.push("utility-shaped name");
    }
    if (node.kind === "route") {
      score *= 2;
      reasons.push("HTTP route");
    }
    if (/routes?\//.test(node.path) || /controllers?\//.test(node.path)) {
      score *= 1.4;
      reasons.push("route or controller location");
    }
    scored.push({ nodeId: node.id, score, reasons });
  }
  scored.sort((left, right) => right.score - left.score);
  return scored;
}

const PROCESS_EDGE_KINDS = new Set([
  "calls",
  "http-route",
  "handles",
  "requests",
]);

/**
 * Bounded static call paths: forward traversal from ranked entry points
 * over supported directed relationships. Cycles are cut by per-path
 * visited sets, branching is capped per level, and the produced paths are
 * structural suggestions — never presented as runtime execution traces.
 */
export function detectProcesses(
  graph: CodeGraph,
  adapter: GraphAdapter,
  entryPoints: EntryPoint[],
): { processes: StaticProcess[]; truncated: boolean } {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const processes: StaticProcess[] = [];
  let truncated = false;
  const started = new Set<string>();
  for (const entry of entryPoints) {
    if (processes.length >= MAX_PROCESSES) {
      truncated = true;
      break;
    }
    if (started.has(entry.nodeId)) continue;
    started.add(entry.nodeId);
    const stack: { nodeId: string; path: string[] }[] = [
      { nodeId: entry.nodeId, path: [entry.nodeId] },
    ];
    let emittedForEntry = 0;
    while (stack.length) {
      const current = stack.pop()!;
      const depth = current.path.length;
      if (depth >= MIN_STEPS && current.path.length <= MAX_DEPTH) {
        const label = current.path
          .slice(0, 3)
          .map((id) => byId.get(id)?.name ?? id)
          .join(" → ");
        processes.push({ nodeIds: current.path, label });
        emittedForEntry += 1;
        if (processes.length >= MAX_PROCESSES) {
          truncated = true;
          break;
        }
      }
      if (depth >= MAX_DEPTH) continue;
      const outbound = adapter
        .outbound(current.nodeId)
        .filter((target) => {
          const edgeKinds = adapter
            .edgesBetween(current.nodeId, target)
            .map((edge) => edge.kind);
          return edgeKinds.some((kind) => kind && PROCESS_EDGE_KINDS.has(kind));
        })
        .filter((target) => !current.path.includes(target))
        .slice(0, MAX_BRANCHING);
      if (adapter.outbound(current.nodeId).length > MAX_BRANCHING)
        truncated = true;
      for (const target of outbound)
        stack.push({ nodeId: target, path: [...current.path, target] });
    }
    if (emittedForEntry === 0 && entry.reasons.includes("HTTP route")) {
      // Routes without reachable paths stay honest: nothing is emitted.
    }
  }
  return { processes, truncated };
}

export function buildIntelligence(
  graph: CodeGraph,
  adapter: GraphAdapter,
): GraphIntelligence {
  const entryPoints = entryPointScores(graph, adapter);
  const { processes, truncated } = detectProcesses(graph, adapter, entryPoints);
  // Communities: connected components over the relationship projection are
  // structural groupings of the selection, not confirmed business modules.
  const communities = adapter
    .connectedComponents()
    .filter((component) => component.length >= 3)
    .sort((left, right) => right.length - left.length)
    .slice(0, 12);
  return {
    entryPoints,
    processes,
    communities,
    truncatedProcesses: truncated,
    truncatedEntryCandidates: entryPoints.length >= MAX_ENTRY_CANDIDATES,
  };
}
