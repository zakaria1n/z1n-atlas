import { z } from "zod";
import {
  analysisRequestSchema,
  graphIsValid,
  type CodeGraph,
} from "@z1n/contracts";

const searchInput = z
  .object({
    query: z.string().trim().min(2).max(100),
    path: z.string().max(500).optional(),
  })
  .strict();
const readInput = z
  .object({
    path: z.string().min(1).max(500),
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
  })
  .strict()
  .refine(
    (value) =>
      value.endLine >= value.startLine && value.endLine - value.startLine < 40,
  );
const neighborInput = z.object({ nodeId: z.string().min(1).max(800) }).strict();
type Source = { path: string; content: string };

export function createEvidenceTools(files: Source[], graph: CodeGraph) {
  analysisRequestSchema.parse({ files, origin: "github", consent: false });
  if (!graphIsValid(graph, files)) throw new Error("Invalid graph evidence.");
  const fileMap = new Map(
    files.map((file) => [file.path, file.content.split(/\r\n|\r|\n/)]),
  );
  return {
    searchCode(input: unknown) {
      const { query, path } = searchInput.parse(input);
      if (path && !fileMap.has(path))
        throw new Error("File is not in the source selection.");
      const matches: {
        path: string;
        line: number;
        text: string;
        truncated: boolean;
      }[] = [];
      let truncated = false;
      for (const [filePath, lines] of fileMap) {
        if (path && path !== filePath) continue;
        for (let index = 0; index < lines.length; index++) {
          if (!lines[index].toLowerCase().includes(query.toLowerCase()))
            continue;
          if (matches.length === 20) {
            truncated = true;
            break;
          }
          matches.push({
            path: filePath,
            line: index + 1,
            text: lines[index].slice(0, 400),
            truncated: lines[index].length > 400,
          });
        }
        if (truncated) break;
      }
      return { matches, truncated };
    },
    readFile(input: unknown) {
      const { path, startLine, endLine } = readInput.parse(input);
      const lines = fileMap.get(path);
      if (!lines || startLine > lines.length || endLine > lines.length)
        throw new Error("Source range is unavailable.");
      let remaining = 8_000;
      const excerpt = lines.slice(startLine - 1, endLine).map((line, index) => {
        const text = line.slice(0, Math.min(400, remaining));
        remaining -= text.length;
        return {
          line: startLine + index,
          text,
          truncated: text.length < line.length,
        };
      });
      return { path, lines: excerpt };
    },
    getGraphNeighbors(input: unknown) {
      const { nodeId } = neighborInput.parse(input);
      const node = graph.nodes.find((item) => item.id === nodeId);
      if (!node) throw new Error("Graph node is unavailable.");
      const related = graph.edges.filter(
        (edge) => edge.source === nodeId || edge.target === nodeId,
      );
      const edges = related.slice(0, 30);
      const ids = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
      const evidenceIds = new Set(
        edges.flatMap((edge) => [
          edge.evidenceId,
          ...(edge.supportingEvidenceIds ?? []),
        ]),
      );
      return {
        nodes: graph.nodes.filter(
          (item) => ids.has(item.id) || item.id === nodeId,
        ),
        edges,
        evidence: graph.evidence
          .filter((item) => evidenceIds.has(item.id))
          .map((item) => ({
            ...item,
            snippet: item.snippet.slice(0, 400),
            truncated: item.snippet.length > 400,
          })),
        truncated: related.length > edges.length,
      };
    },
  };
}
