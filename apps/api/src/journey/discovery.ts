import type { CodeGraph, GraphNode } from "@z1n/contracts";

const STOP = new Set([
  "how",
  "does",
  "the",
  "from",
  "with",
  "what",
  "where",
  "user",
  "and",
  "for",
  "into",
  "that",
  "this",
  "explain",
  "show",
  "source",
  "evidence",
  "final",
]);
function tokens(text: string): string[] {
  return (
    text
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .match(/[a-z0-9]{3,}/g)
      ?.map((word) =>
        word
          .replace(/s$/, "")
          .replace(/(ing|ed|es)$/, "")
          // Fold doubled final consonants so "committed" matches "commit".
          .replace(/(.)\1$/, "$1"),
      )
      .filter((word) => word.length > 2 && !STOP.has(word)) ?? []
  );
}
type Candidate = {
  node: GraphNode;
  score: number;
  signals: string[];
  context: GraphNode[];
};
export function discoverCandidates(
  question: string,
  files: { path: string; content: string }[],
  graph: CodeGraph,
): Candidate[] {
  const words = [...new Set(tokens(question))];
  if (!words.length) return [];
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const lines = new Map(
    files.map((file) => [file.path, file.content.split(/\r\n|\r|\n/)]),
  );
  const adjacency = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (
      ![
        "handles",
        "calls",
        "requests",
        "http-route",
        "handles-event",
        "renders",
      ].includes(edge.kind)
    )
      continue;
    for (const [a, b] of [
      [edge.source, edge.target],
      [edge.target, edge.source],
    ]) {
      if (!adjacency.has(a)) adjacency.set(a, new Set());
      adjacency.get(a)!.add(b);
    }
  }
  const scored = graph.nodes
    .filter((node) => node.kind && node.kind !== "file")
    .map((node) => {
      const nameWords = new Set(tokens(node.name ?? ""));
      const pathWords = new Set(tokens(node.path));
      const source = lines.get(node.path) ?? [];
      const start = Math.max(0, (node.startLine ?? 1) - 1);
      const snippetWords = new Set(
        tokens(
          source
            .slice(start, Math.min(node.endLine ?? start + 1, start + 120))
            .join(" ")
            .slice(0, 12000),
        ),
      );
      const count = (set: Set<string>) =>
        words.filter((word) => set.has(word)).length;
      const name = count(nameWords),
        path = count(pathWords),
        snippet = count(snippetWords);
      return {
        node,
        base: name * 5 + path * 3 + snippet,
        signals: [
          name ? "symbol" : "",
          path ? "path" : "",
          snippet ? "source" : "",
        ].filter(Boolean),
      };
    });
  const scores = new Map(scored.map((item) => [item.node.id, item.base]));
  return scored
    .map((item) => {
      const context = [...(adjacency.get(item.node.id) ?? [])]
        .map((id) => byId.get(id))
        .filter((node): node is GraphNode => Boolean(node));
      const connected = context.reduce(
        (best, node) => Math.max(best, scores.get(node.id) ?? 0),
        0,
      );
      return {
        node: item.node,
        score:
          (item.base + connected * 0.35) *
          (item.node.kind === "route" && connected ? 1.8 : 1),
        signals: [...item.signals, ...(connected ? ["connected-symbol"] : [])],
        context,
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));
}
