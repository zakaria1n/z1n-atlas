import { z } from "zod";
import type { EvidenceRegistry } from "./registry";

type ToolCall = { name: string; arguments: string };

const searchResult = z
  .object({
    matches: z
      .array(
        z
          .object({
            path: z.string(),
            line: z.number(),
            text: z.string(),
            truncated: z.boolean().optional(),
          })
          .loose(),
      )
      .max(40),
  })
  .loose();
const readResult = z
  .object({
    path: z.string(),
    lines: z
      .array(z.object({ line: z.number(), text: z.string() }).loose())
      .max(60),
  })
  .loose();
const neighborsResult = z
  .object({
    nodes: z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string().nullish(),
            kind: z.string().nullish(),
            path: z.string(),
            startLine: z.number().nullish(),
          })
          .loose(),
      )
      .max(40),
    edges: z
      .array(
        z
          .object({
            id: z.string(),
            source: z.string(),
            target: z.string(),
            kind: z.string(),
            evidenceId: z.string().optional(),
            confidence: z.string().optional(),
          })
          .loose(),
      )
      .max(40),
    evidence: z
      .array(
        z
          .object({
            id: z.string(),
            filePath: z.string(),
            startLine: z.number(),
            endLine: z.number(),
            snippet: z.string(),
          })
          .loose(),
      )
      .max(40),
  })
  .loose();
const symbolsResult = z
  .object({
    symbols: z
      .array(
        z
          .object({
            ref: z.string().optional(),
            name: z.string().nullish(),
            kind: z.string().nullish(),
            path: z.string(),
            line: z.number().optional(),
          })
          .loose(),
      )
      .max(20),
  })
  .loose();
const routesResult = z
  .object({
    routes: z
      .array(
        z
          .object({
            nodeId: z.string().optional(),
            route: z.string().nullish(),
            filePath: z.string(),
            lines: z.array(z.number()).optional(),
          })
          .loose(),
      )
      .max(10),
  })
  .loose();
const discoveryResult = z
  .object({
    candidates: z
      .array(
        z
          .object({
            ref: z.string().optional(),
            name: z.string().nullish(),
            kind: z.string().nullish(),
            path: z.string(),
            line: z.number().optional(),
          })
          .loose(),
      )
      .max(12),
  })
  .loose();

const confidenceSchema = z.enum(["confirmed", "framework", "heuristic"]);

type SummaryEntry = {
  ref?: string;
  name?: string | null;
  kind?: string | null;
  path: string;
  line?: number;
};

const nodeSummary = (node: SummaryEntry): string =>
  `${node.name ?? node.path} (${node.kind ?? "file"} in ${node.path})`;

/**
 * Registers everything a shared tool answered into the conversation's
 * evidence ledger: literal source lines from search and read, relationship
 * evidence from graph neighbors, and node summaries from discovery,
 * symbols and routes. Only ids the model actually saw become citable.
 */
export function registerToolResult(
  registry: EvidenceRegistry,
  call: ToolCall,
  output: string,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  if (call.name === "search_code") {
    const result = searchResult.safeParse(parsed);
    if (!result.success) return;
    for (const match of result.data.matches)
      registry.add({
        id: `source:${match.path}:${match.line}`,
        filePath: match.path,
        startLine: match.line,
        endLine: match.line,
        snippet: match.text,
      });
    return;
  }
  if (call.name === "read_file") {
    const result = readResult.safeParse(parsed);
    if (!result.success) return;
    for (const line of result.data.lines)
      registry.add({
        id: `source:${result.data.path}:${line.line}`,
        filePath: result.data.path,
        startLine: line.line,
        endLine: line.line,
        snippet: line.text,
      });
    return;
  }
  if (call.name === "get_graph_neighbors") {
    const result = neighborsResult.safeParse(parsed);
    if (!result.success) return;
    for (const item of result.data.evidence) {
      // Only the edge that cites this evidence as its own proves the
      // relationship; supporting items are supplied without a label.
      const edge = result.data.edges.find(
        (candidate) => candidate.evidenceId === item.id,
      );
      const confidence = edge
        ? confidenceSchema.safeParse(edge.confidence ?? "confirmed")
        : undefined;
      registry.add({
        id: item.id,
        filePath: item.filePath,
        startLine: item.startLine,
        endLine: item.endLine,
        snippet: item.snippet.slice(0, 1000),
        ...(edge && confidence?.success
          ? {
              relationship: {
                edgeId: edge.id,
                source: edge.source,
                target: edge.target,
                kind: edge.kind,
                confidence: confidence.data,
              },
            }
          : {}),
      });
    }
    return;
  }
  const entries: SummaryEntry[] = (() => {
    if (call.name === "find_symbols") {
      const result = symbolsResult.safeParse(parsed);
      return result.success ? result.data.symbols : [];
    }
    if (call.name === "find_routes") {
      const result = routesResult.safeParse(parsed);
      return result.success
        ? result.data.routes.map((route) => ({
            ref: route.nodeId,
            name: route.route,
            kind: "route",
            path: route.filePath,
            line: route.lines?.[0],
          }))
        : [];
    }
    const result = discoveryResult.safeParse(parsed);
    return result.success ? result.data.candidates : [];
  })();
  for (const node of entries) {
    const id = `node:${node.ref ?? `${node.path}#${node.line ?? 1}`}`;
    const start = node.line ?? 1;
    registry.add({
      id,
      filePath: node.path,
      startLine: start,
      endLine: start,
      snippet: registry.verbatimSnippet(
        node.path,
        start,
        start,
        nodeSummary(node),
      ),
    });
  }
}
