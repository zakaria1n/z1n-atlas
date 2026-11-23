import type { CodeGraph } from "./contracts";

type Input = { path: string; content: string };
export function graphIsValid(graph: CodeGraph, files: Input[]): boolean {
  const fileMap = new Map(files.map((file) => [file.path, file.content]));
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
  const nodes = new Set(nodeMap.keys());
  if (
    nodes.size !== graph.nodes.length ||
    graph.nodes.some(
      (node) =>
        !fileMap.has(node.path) ||
        ((!node.kind || node.kind === "file") && node.id !== node.path) ||
        (Boolean(node.kind && node.kind !== "file") &&
          (!node.id.startsWith(`${node.path}#`) ||
            !node.name ||
            !node.startLine ||
            !node.endLine ||
            node.startLine < 1 ||
            node.endLine < node.startLine ||
            node.endLine >
              (fileMap.get(node.path)?.split(/\r\n|\r|\n/).length ?? 0))),
    )
  )
    return false;
  const evidence = new Map(graph.evidence.map((item) => [item.id, item]));
  if (
    evidence.size !== graph.evidence.length ||
    new Set(graph.edges.map((edge) => edge.id)).size !== graph.edges.length
  )
    return false;
  const linkedEvidence = new Set(graph.edges.map((edge) => edge.evidenceId));
  return (
    graph.edges.every((edge) => {
      const item = evidence.get(edge.evidenceId);
      if (
        !item ||
        !nodes.has(edge.source) ||
        !nodes.has(edge.target) ||
        item.filePath !== nodeMap.get(edge.source)?.path ||
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
    }) && graph.evidence.every((item) => linkedEvidence.has(item.id))
  );
}
