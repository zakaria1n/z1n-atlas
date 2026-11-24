import {
  journeyIsValid,
  journeySchema,
  type CodeGraph,
  type GraphEdge,
  type Journey,
} from "@z1n/contracts";
const allowed = new Set<GraphEdge["kind"]>([
  "calls",
  "requests",
  "http-route",
  "handles",
  "database-access",
  "renders",
]);
const stop = new Set([
  "how",
  "does",
  "the",
  "work",
  "works",
  "what",
  "where",
  "feature",
  "flow",
  "through",
  "with",
  "from",
]);
export function findJourney(
  goal: string,
  graph: CodeGraph,
  evidencePaths: string[] = [],
): Journey {
  const terms = [...new Set(goal.toLowerCase().match(/[a-z0-9_$]{3,}/g) ?? [])]
    .filter((word) => !stop.has(word))
    .slice(0, 8);
  if (terms.some((word) => /^(registration|register|signup)$/.test(word)))
    terms.push("user", "create", "register", "signup");
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
  const text = (id: string) => {
    const node = nodeMap.get(id);
    return `${node?.name ?? ""} ${node?.path ?? ""}`.toLowerCase();
  };
  const matched = graph.nodes
    .filter(
      (node) =>
        node.kind !== "file" &&
        (terms.some((term) => text(node.id).includes(term)) ||
          evidencePaths.includes(node.path)),
    )
    .slice(0, 60);
  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges)
    if (allowed.has(edge.kind)) {
      if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
      if (!incoming.has(edge.target)) incoming.set(edge.target, []);
      outgoing.get(edge.source)!.push(edge);
      incoming.get(edge.target)!.push(edge);
    }
  const starts = new Set(matched.map((node) => node.id));
  let frontier = [...starts];
  for (let depth = 0; depth < 3; depth++) {
    const next: string[] = [];
    for (const id of frontier)
      for (const edge of incoming.get(id) ?? [])
        if (!starts.has(edge.source) && starts.size < 150) {
          starts.add(edge.source);
          next.push(edge.source);
        }
    frontier = next;
  }
  let best: { nodes: string[]; edges: GraphEdge[]; score: number } | undefined;
  let explored = 0;
  function visit(nodes: string[], edges: GraphEdge[]) {
    if (++explored > 10_000) return;
    const names = nodes.map(text).join(" ");
    const relevance =
      terms.reduce((sum, term) => sum + (names.includes(term) ? 1 : 0), 0) +
      Math.min(
        3,
        new Set(
          nodes
            .map((id) => nodeMap.get(id)?.path)
            .filter((path) => path && evidencePaths.includes(path)),
        ).size,
      ) *
        2;
    if (relevance) {
      const score =
        relevance * 10 +
        edges.length * 2 +
        (/\.(tsx|jsx)\b/.test(text(nodes[0])) ? 20 : 0) +
        (edges.some((edge) => edge.kind === "http-route") ? 5 : 0);
      if (!best || score > best.score)
        best = { nodes: [...nodes], edges: [...edges], score };
    }
    if (edges.length >= 11) return;
    for (const edge of (outgoing.get(nodes[nodes.length - 1]) ?? []).slice(
      0,
      30,
    ))
      if (!nodes.includes(edge.target))
        visit([...nodes, edge.target], [...edges, edge]);
  }
  for (const start of starts) {
    if (explored > 10_000) break;
    visit([start], []);
  }
  if (!best)
    return {
      nodeIds: [],
      edgeIds: [],
      uncertainties: [
        "No matching supported path was found. Try a symbol, file or feature name from the project.",
      ],
    };
  const chosen: { nodes: string[]; edges: GraphEdge[]; score: number } = best;
  const uncertainties = [
    evidencePaths.length
      ? "This candidate static path was ranked using names and AI-selected source evidence; it is not a verified runtime trace and may be incomplete."
      : "This is a candidate static path selected by names; it is not a verified runtime trace and may be incomplete.",
  ];
  if (chosen.edges.some((edge) => edge.confidence === "heuristic"))
    uncertainties.push(
      "At least one transition is heuristic and has not been verified at runtime.",
    );
  const last = nodeMap.get(chosen.nodes[chosen.nodes.length - 1]);
  if (last?.kind === "http-call")
    uncertainties.push(
      "No supported backend route was resolved for the final request.",
    );
  if (last?.kind === "route")
    uncertainties.push(
      "No supported handler was resolved for the final route.",
    );
  if (!chosen.edges.length)
    uncertainties.push(
      "No supported transition was found for this matching symbol.",
    );
  if (explored > 10_000)
    uncertainties.push(
      "Search reached its exploration limit; other paths may exist.",
    );
  const result = journeySchema.parse({
    nodeIds: chosen.nodes,
    edgeIds: chosen.edges.map((edge) => edge.id),
    uncertainties,
  });
  if (!journeyIsValid(result, graph))
    throw new Error("Journey contains invalid graph references.");
  return result;
}
