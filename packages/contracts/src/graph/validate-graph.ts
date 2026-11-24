import type { CodeGraph } from "./contracts";

type Input = { path: string; content: string };
type Evidence = CodeGraph["evidence"][number];
const lineBreak = /\r\n|\r|\n/;

export function graphIsValid(graph: CodeGraph, files: Input[]): boolean {
  // Graphs of large selections carry tens of thousands of evidence items, so
  // every file is split into lines once instead of once per item.
  const lines = new Map(
    files.map((file) => [file.path, file.content.split(lineBreak)]),
  );
  const lineCount = (path: string) => lines.get(path)?.length ?? 0;
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
  const nodes = new Set(nodeMap.keys());
  if (
    nodes.size !== graph.nodes.length ||
    graph.nodes.some(
      (node) =>
        !lines.has(node.path) ||
        ((!node.kind || node.kind === "file") && node.id !== node.path) ||
        (Boolean(node.kind && node.kind !== "file") &&
          (!node.id.startsWith(`${node.path}#`) ||
            !node.name ||
            !node.startLine ||
            !node.endLine ||
            node.startLine < 1 ||
            node.endLine < node.startLine ||
            node.endLine > lineCount(node.path))),
    )
  )
    return false;
  const evidence = new Map(graph.evidence.map((item) => [item.id, item]));
  if (
    evidence.size !== graph.evidence.length ||
    new Set(graph.edges.map((edge) => edge.id)).size !== graph.edges.length
  )
    return false;
  const linkedEvidence = new Set(
    graph.edges.flatMap((edge) => [
      edge.evidenceId,
      ...(edge.supportingEvidenceIds ?? []),
    ]),
  );
  const validEvidence = (item: Evidence) => {
    const fileLines = lines.get(item.filePath);
    if (
      !fileLines ||
      item.startLine < 1 ||
      item.endLine < item.startLine ||
      item.endLine > fileLines.length
    )
      return false;
    if (item.startLine === item.endLine)
      return fileLines[item.startLine - 1].includes(item.snippet);
    return fileLines
      .slice(item.startLine - 1, item.endLine)
      .join("\n")
      .includes(item.snippet.replace(/\r\n|\r/g, "\n"));
  };
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
      return (
        validEvidence(item) &&
        (edge.supportingEvidenceIds ?? []).every((id) => {
          const supporting = evidence.get(id);
          return Boolean(supporting && validEvidence(supporting));
        })
      );
    }) && graph.evidence.every((item) => linkedEvidence.has(item.id))
  );
}
