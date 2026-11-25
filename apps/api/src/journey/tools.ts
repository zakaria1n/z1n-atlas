import { z } from "zod";
import {
  analysisRequestSchema,
  graphIsValid,
  type CodeGraph,
  type GraphNode,
} from "@z1n/contracts";
import { createEvidenceTools } from "../evidence/tools";
import { journeyKinds } from "./journey-kinds";

type Source = { path: string; content: string };
// Results are serialized into the model conversation, so each tool answer
// stays small enough for several rounds to fit the request budget.
const MAX_RESULT_CHARS = 4_000;
const routeInput = z
  .object({
    method: z.string().trim().min(3).max(10).optional(),
    path: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export type JourneyToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};
export type JourneyToolCall = { name: string; arguments: string };
export type JourneyToolResult = { name: string; output: string };

/**
 * The read-only tools the journey model may call. Every result comes from
 * the analyzed selection and its verified graph: the model can look at code,
 * follow relationships and list routes, but it cannot obtain anything that
 * is not already evidence-backed.
 */
export function createJourneyTools(files: Source[], graph: CodeGraph) {
  analysisRequestSchema.parse({ files, origin: "github", consent: false });
  if (!graphIsValid(graph, files)) throw new Error("Invalid graph evidence.");
  const evidence = createEvidenceTools(files, graph);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const label = (id: string) => {
    const node = byId.get(id);
    if (!node) return id;
    return node.kind && node.kind !== "file"
      ? `${node.name} (${node.kind} in ${node.path})`
      : node.path;
  };
  const tools = {
    search_code: (input: unknown) => evidence.searchCode(input),
    read_file: (input: unknown) => evidence.readFile(input),
    get_graph_neighbors: (input: unknown) => {
      const result = evidence.getGraphNeighbors(input);
      return {
        ...result,
        edges: result.edges.map((edge) => ({
          id: edge.id,
          from: label(edge.source),
          sourceId: edge.source,
          to: label(edge.target),
          targetId: edge.target,
          relationship: edge.kind,
          confidence: edge.confidence,
        })),
      };
    },
    find_routes: (input: unknown) => {
      const { method, path } = routeInput.parse(input ?? {});
      const routes = graph.nodes
        .filter(
          (node) =>
            node.kind === "route" &&
            (!method ||
              (node.name ?? "")
                .toUpperCase()
                .startsWith(method.toUpperCase())) &&
            (!path ||
              (node.name ?? "").toLowerCase().includes(path.toLowerCase())),
        )
        .slice(0, 10)
        .map((node: GraphNode) => ({
          nodeId: node.id,
          route: node.name,
          filePath: node.path,
          lines: [node.startLine, node.endLine],
          handlers: graph.edges
            .filter(
              (edge) => edge.source === node.id && journeyKinds.has(edge.kind),
            )
            .map((edge) => ({
              edgeId: edge.id,
              handlerId: edge.target,
              handler: label(edge.target),
              relationship: edge.kind,
            })),
        }));
      return {
        routes,
        truncated:
          graph.nodes.some((node) => node.kind === "route") &&
          routes.length === 10,
      };
    },
  };
  const definitions: JourneyToolDefinition[] = [
    {
      name: "search_code",
      description:
        "Search the analyzed source for a case-insensitive string. Returns matching file paths, line numbers and lines.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 2, maxLength: 100 },
          path: { type: "string", maxLength: 500 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "read_file",
      description:
        "Read up to 40 lines of an analyzed file with their line numbers.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", maxLength: 500 },
          startLine: { type: "integer", minimum: 1 },
          endLine: { type: "integer", minimum: 1 },
        },
        required: ["path", "startLine", "endLine"],
        additionalProperties: false,
      },
    },
    {
      name: "get_graph_neighbors",
      description:
        "List the verified relationships of one graph node, with the node and edge identifiers needed to cite them.",
      parameters: {
        type: "object",
        properties: {
          nodeId: { type: "string", maxLength: 800 },
        },
        required: ["nodeId"],
        additionalProperties: false,
      },
    },
    {
      name: "find_routes",
      description:
        "List analyzed HTTP routes by method or path fragment, with the handlers each route is connected to.",
      parameters: {
        type: "object",
        properties: {
          method: { type: "string", minLength: 3, maxLength: 10 },
          path: { type: "string", minLength: 1, maxLength: 200 },
        },
        additionalProperties: false,
      },
    },
  ];
  const registry = new Map(
    Object.entries(tools) as [string, (input: unknown) => unknown][],
  );
  function execute(call: JourneyToolCall): JourneyToolResult {
    const run = registry.get(call.name);
    if (!run)
      return {
        name: call.name,
        output: `Unknown tool "${call.name}". Available: ${[...registry.keys()].join(", ")}.`,
      };
    let args: unknown;
    try {
      args = JSON.parse(call.arguments || "{}");
    } catch {
      return { name: call.name, output: "Arguments must be a JSON object." };
    }
    try {
      const result = run(args);
      let output = JSON.stringify(result);
      if (output.length > MAX_RESULT_CHARS)
        output = `${output.slice(0, MAX_RESULT_CHARS)}… [truncated]`;
      return { name: call.name, output };
    } catch (error) {
      return {
        name: call.name,
        output: `The tool rejected this call: ${error instanceof Error ? error.message : "invalid input"}.`,
      };
    }
  }
  return { definitions, execute, available: [...registry.keys()] };
}
