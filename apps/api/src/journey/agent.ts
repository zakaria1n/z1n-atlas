import { z } from "zod";
import {
  journeyIsValid,
  journeySchema,
  type CodeGraph,
  type Journey,
} from "@z1n/contracts";
import { createJourneyTools } from "./tools";
import { journeyKinds } from "./journey-kinds";
import {
  completePersistenceEvidence,
  qualifyUnsupportedAbsence,
} from "./complete-evidence";
import { groundExplanations } from "./claims";

export type AgentMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text?: string; toolCalls?: AgentToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };
export type AgentToolCall = {
  id: string;
  name: string;
  arguments: string;
};
export type AgentTurn =
  | { kind: "final"; text: string }
  | { kind: "tools"; toolCalls: AgentToolCall[] };
export type AgentGenerate = (input: {
  system: string;
  messages: AgentMessage[];
  tools: ReturnType<typeof createJourneyTools>["definitions"];
  signal?: AbortSignal;
}) => Promise<AgentTurn>;

// Slower exploring models spend rounds reading before they answer; the
// budget stays hard, and the system instructions tell the model to close.
const MAX_ROUNDS = 6;
const MAX_TOOL_CALLS = 18;
const MAX_STEPS = 12;
const MAX_MODEL_UNCERTAINTIES = 4;
const TIMEOUT_MS = 30_000;
const TOTAL_TIMEOUT_MS = 180_000;
const JSON_FENCE = /^\s*```(?:json)?\s*/i;

export const JOURNEY_SYSTEM_INSTRUCTIONS =
  "You guide exploration of one analyzed source selection and explain how a feature works. " +
  "Start with discover_feature using the user's question to find ranked source candidates and connected routes. If literal searches are empty, broaden them; absence of matches does not establish absence. find_symbols returns short node references, search_code finds strings, read_file reads lines, " +
  "get_graph_neighbors lists the verified relationships of a node with the identifiers to cite, " +
  "find_routes lists HTTP routes and their handlers. " +
  "Ground every step in tool results: cite only node identifiers that a tool returned, and never invent identifiers, files, lines or relationships. " +
  "In each explanation, quote the exact code fragments you read (in backticks), such as a called function or a field: the backend verifies those fragments against the analyzed files and labels every explanation with the support it could verify. " +
  "Never write confirmed, proven or guaranteed: state what the static evidence shows. " +
  "Distinguish code facts, static inferences and heuristics. A search with no matches does not prove a feature is absent; state only what was searched and remains unknown. " +
  "Follow supported relationships only: calls, requests, http-route, handles, handles-event, database-access, renders. " +
  "A path explains a feature from its user-facing entry, such as a component or event handler, through requests, routes, handlers and services, to data access when the code supports it. " +
  "Stop where the analyzed evidence stops: if a request has no matching backend route, end the path there and say so in uncertainties. " +
  "If the tools cannot find the feature, return an empty steps array and explain what is missing. " +
  "Use short references returned by tools. Related database operations belonging to a path function can be listed separately; they are not consecutive execution steps. " +
  "When persistence is relevant, use get_graph_neighbors with relationship database-access on the owning function and inspect additional pages if provided. " +
  "Each pair of consecutive path steps must have an outgoing edge between those exact references; sibling callees of one function cannot be chained. " +
  "After exploring, reply with JSON only and no tool calls: " +
  '{"steps":[{"nodeId":"<reference from tools>","text":"<why this step belongs to the feature>"}],"relatedOperations":[{"ownerId":"<path reference>","nodeId":"<database reference>"}],"uncertainties":["<limits such as unmatched boundaries or heuristic transitions>"]}. ' +
  "Order steps from the entry point to the result and use at most 12 steps. Keep each explanation under 600 characters and each uncertainty under 500 characters.";
const draftSchema = z
  .object({
    steps: z
      .array(
        z
          .object({
            nodeId: z.string().min(1).max(1000),
            text: z.string().min(1).max(600),
          })
          .strict(),
      )
      .max(MAX_STEPS),
    uncertainties: z.array(z.string().min(1).max(500)).max(6).optional(),
    relatedOperations: z
      .array(
        z
          .object({
            ownerId: z.string().min(1).max(1000),
            nodeId: z.string().min(1).max(1000),
          })
          .strict(),
      )
      .max(24)
      .optional(),
  })
  .strict();

function parseDraft(
  text: string,
): { draft: z.infer<typeof draftSchema> } | { error: string } {
  const body = text.replace(JSON_FENCE, "").replace(/\s*```\s*$/, "");
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return { error: "No JSON object was found." };
  try {
    const parsed = draftSchema.safeParse(
      JSON.parse(body.slice(start, end + 1)),
    );
    return parsed.success
      ? { draft: parsed.data }
      : {
          error: `Invalid answer structure: ${parsed.error.issues
            .map(
              (issue) =>
                `${issue.path.join(".") || "answer"}: ${issue.message}`,
            )
            .join("; ")
            .slice(0, 600)}`,
        };
  } catch {
    return { error: "The answer contains malformed JSON." };
  }
}

type Built = { journey: Journey } | { error: string };
function buildJourney(
  draft: z.infer<typeof draftSchema>,
  graph: CodeGraph,
  resolveReference: (ref: string) => string | undefined,
): Built {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const label = (id: string) => {
    const node = byId.get(id);
    return node
      ? node.kind && node.kind !== "file"
        ? `${node.name} (${node.kind} in ${node.path})`
        : node.path
      : id;
  };
  const nodeIds: string[] = [];
  const explanations: { nodeId: string; text: string }[] = [];
  for (const step of draft.steps) {
    const nodeId = resolveReference(step.nodeId) ?? step.nodeId;
    if (!byId.has(nodeId))
      return {
        error: `"${step.nodeId}" is not a node of this graph. Use identifiers exactly as a tool returned them.`,
      };
    if (nodeIds.includes(nodeId))
      return { error: `"${step.nodeId}" appears twice in the path.` };
    nodeIds.push(nodeId);
    explanations.push({ nodeId, text: qualifyUnsupportedAbsence(step.text) });
  }
  const edgeIds: string[] = [];
  const boundaries: string[] = [];
  for (let index = 0; index < nodeIds.length - 1; index++) {
    const [from, to] = [nodeIds[index], nodeIds[index + 1]];
    const edge = graph.edges.find(
      (item) =>
        item.source === from &&
        item.target === to &&
        journeyKinds.has(item.kind),
    );
    if (!edge) boundaries.push(`${label(from)} to ${label(to)}`);
    else edgeIds.push(edge.id);
  }
  if (boundaries.length)
    return {
      error: `No supported relationship in the graph connects ${boundaries.join("; ")}. Only cite consecutive steps that get_graph_neighbors or find_routes showed as connected, or end the path at the last connected node.`,
    };
  const uncertainties = [
    ...(draft.uncertainties
      ?.map((text) => qualifyUnsupportedAbsence(text).slice(0, 500))
      .slice(0, MAX_MODEL_UNCERTAINTIES) ?? []),
  ];
  if (!uncertainties.length)
    uncertainties.push(
      "The model reported no limitations, but a selected path is never a verified runtime trace.",
    );
  const relatedOperations: {
    ownerId: string;
    nodeId: string;
    edgeId: string;
  }[] = [];
  for (const item of draft.relatedOperations ?? []) {
    const ownerId = resolveReference(item.ownerId) ?? item.ownerId;
    const nodeId = resolveReference(item.nodeId) ?? item.nodeId;
    const edge = graph.edges.find(
      (candidate) =>
        candidate.source === ownerId &&
        candidate.target === nodeId &&
        candidate.kind === "database-access",
    );
    if (
      !nodeIds.includes(ownerId) ||
      byId.get(nodeId)?.kind !== "database" ||
      !edge
    )
      return {
        error: `Related operation ${item.nodeId} is not a verified database operation of path step ${item.ownerId}.`,
      };
    relatedOperations.push({ ownerId, nodeId, edgeId: edge.id });
  }
  const candidate = journeySchema.parse({
    mode: "ai",
    nodeIds,
    edgeIds,
    uncertainties,
    explanations,
    relatedOperations,
  });
  if (!journeyIsValid(candidate, graph))
    return { error: "The proposed path did not match the graph." };
  return { journey: candidate };
}

export type JourneyAgentInput = {
  question: string;
  files: { path: string; content: string }[];
  graph: CodeGraph;
  generate: AgentGenerate;
  signal?: AbortSignal;
  maxRounds?: number;
  maxToolCalls?: number;
};

/**
 * Runs the bounded tool-calling loop that lets the model explore the
 * selection and propose a feature path. The model chooses what to inspect;
 * every identifier it cites is validated against the graph here, and the
 * edges of the returned journey always come from the graph itself.
 */
export async function runJourneyAgent(
  input: JourneyAgentInput,
): Promise<Journey> {
  const { question, files, graph, generate, signal } = input;
  let partial: Journey | undefined;
  const unknown = (message: string): Journey =>
    partial
      ? {
          ...partial,
          uncertainties: [
            ...partial.uncertainties.slice(0, 6),
            "This is a partial path; later proposed steps could not be validated.",
            message,
          ],
        }
      : { mode: "ai", nodeIds: [], edgeIds: [], uncertainties: [message] };
  const tools = createJourneyTools(files, graph);
  const totalTimeout = AbortSignal.timeout(TOTAL_TIMEOUT_MS);
  const messages: AgentMessage[] = [{ role: "user", text: question }];
  let toolCalls = 0;
  let corrective = 0;
  const priorCalls = new Set<string>();
  const maxRounds = Math.max(
    1,
    Math.min(20, Math.trunc(input.maxRounds ?? MAX_ROUNDS) || MAX_ROUNDS),
  );
  const maxToolCalls = Math.max(
    1,
    Math.min(
      60,
      Math.trunc(input.maxToolCalls ?? MAX_TOOL_CALLS) || MAX_TOOL_CALLS,
    ),
  );
  for (let round = 0; round < maxRounds; round++) {
    let turn: AgentTurn;
    try {
      turn = await generate({
        system: JOURNEY_SYSTEM_INSTRUCTIONS,
        messages,
        tools: tools.definitions,
        signal: AbortSignal.any([
          ...(signal ? [signal] : []),
          totalTimeout,
          AbortSignal.timeout(TIMEOUT_MS),
        ]),
      });
    } catch {
      return unknown(
        "The AI provider could not complete the exploration. Check the provider and model in Settings.",
      );
    }
    if (turn.kind === "tools") {
      const calls = turn.toolCalls.slice(0, maxToolCalls - toolCalls);
      toolCalls += calls.length;
      messages.push({
        role: "assistant",
        toolCalls: calls.map(({ id, name, arguments: args }) => ({
          id,
          name,
          arguments: args,
        })),
      });
      for (const call of calls) {
        let key = `${call.name}:${call.arguments}`;
        try {
          const args: unknown = JSON.parse(call.arguments || "{}");
          if (args && typeof args === "object" && !Array.isArray(args))
            key = `${call.name}:${JSON.stringify(Object.entries(args).sort(([a], [b]) => a.localeCompare(b)))}`;
        } catch {
          // Invalid arguments are reported by the tool itself.
        }
        const repeated = priorCalls.has(key);
        priorCalls.add(key);
        const result = repeated
          ? {
              name: call.name,
              output: JSON.stringify({
                notice:
                  "This tool call was already answered; use the earlier result.",
              }),
            }
          : tools.execute(call);
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: result.name,
          content: result.output,
        });
      }
      if (toolCalls >= maxToolCalls) {
        messages.push({
          role: "user",
          text: "The tool budget is used up. Answer now with the final JSON and no tool calls.",
        });
      }
      continue;
    }
    const parsed = parseDraft(turn.text);
    if ("error" in parsed) {
      if (corrective++ >= 2) {
        return unknown(
          "The model did not return the expected JSON answer about this feature.",
        );
      }
      messages.push({ role: "assistant", text: turn.text });
      messages.push({
        role: "user",
        text: `${parsed.error} Reply with JSON only: {"steps":[{"nodeId":"...","text":"..."}],"relatedOperations":[{"ownerId":"...","nodeId":"..."}],"uncertainties":["..."]}. Keep each step under 600 characters and each uncertainty under 500.`,
      });
      continue;
    }
    const built = buildJourney(parsed.draft, graph, tools.resolveReference);
    if ("error" in built) {
      for (let size = parsed.draft.steps.length; size > 0; size--) {
        const prefix = buildJourney(
          {
            ...parsed.draft,
            steps: parsed.draft.steps.slice(0, size),
            relatedOperations: [],
          },
          graph,
          tools.resolveReference,
        );
        if ("journey" in prefix) {
          if (
            prefix.journey.edgeIds.some(
              (id) =>
                graph.edges.find((edge) => edge.id === id)?.confidence ===
                "heuristic",
            )
          )
            prefix.journey.uncertainties.push(
              "This partial path contains a heuristic relationship and is not a verified runtime trace.",
            );
          if (
            !partial ||
            prefix.journey.nodeIds.length > partial.nodeIds.length
          )
            partial = prefix.journey;
          break;
        }
      }
      if (corrective++ >= 2) {
        return unknown(`Invalid journey: ${built.error.slice(0, 400)}`);
      }
      messages.push({ role: "assistant", text: turn.text });
      messages.push({
        role: "user",
        text: `Your answer was rejected: ${built.error}`,
      });
      continue;
    }
    const { journey } = built;
    const heuristic = journey.edgeIds.filter((id) => {
      const edge = graph.edges.find((item) => item.id === id);
      return edge?.confidence === "heuristic";
    }).length;
    if (heuristic)
      journey.uncertainties.push(
        `${heuristic} transition${heuristic > 1 ? "s are" : " is"} heuristic: the request and the backend route are a possible match, not a verified call.`,
      );
    if (!journey.edgeIds.length && journey.nodeIds.length)
      journey.uncertainties.push(
        "No supported transition was found for this matching symbol.",
      );
    const completed = completePersistenceEvidence(journey, graph, question);
    if (!journeyIsValid(completed, graph))
      return unknown("The additional evidence could not be validated.");
    const grounded = groundExplanations(completed, graph, files);
    if (!journeyIsValid(grounded, graph, files))
      return unknown("The explanation evidence could not be verified.");
    return journeySchema.parse({
      ...grounded,
      uncertainties: grounded.uncertainties.slice(0, 8),
    });
  }
  return unknown(
    "The exploration ended without a validated path. Try a more specific question or the static exploration mode.",
  );
}
