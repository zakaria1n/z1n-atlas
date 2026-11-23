import type { CodeGraph } from "./contracts";

type Input = { path: string; content: string };
export function graphIsValid(graph: CodeGraph, files: Input[]): boolean {
  const fileMap = new Map(files.map((file) => [file.path, file.content]));
  const nodes = new Set(graph.nodes.map((node) => node.id));
  if (
    nodes.size !== graph.nodes.length ||
    graph.nodes.some((node) => node.id !== node.path || !fileMap.has(node.path))
  )
    return false;
  const evidence = new Map(graph.evidence.map((item) => [item.id, item]));
  if (
    evidence.size !== graph.evidence.length ||
    new Set(graph.edges.map((edge) => edge.id)).size !== graph.edges.length
  )
    return false;
  return (
    graph.edges.every((edge) => {
      const item = evidence.get(edge.evidenceId);
      if (
        !item ||
        !nodes.has(edge.source) ||
        !nodes.has(edge.target) ||
        item.filePath !== edge.source ||
        item.startLine < 1 ||
        item.endLine < item.startLine
      )
        return false;
      const lines = fileMap.get(item.filePath)?.split(/\r\n|\r|\n/);
      if (!lines || item.endLine > lines.length) return false;
      return lines
        .slice(item.startLine - 1, item.endLine)
        .join("\n")
        .includes(item.snippet.replace(/\r\n|\r/g, "\n"));
    }) &&
    graph.evidence.every((item) =>
      graph.edges.some((edge) => edge.evidenceId === item.id),
    )
  );
}
