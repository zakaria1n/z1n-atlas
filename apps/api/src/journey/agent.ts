import { z } from "zod";
import {
  journeyIsValid,
  journeySchema,
  type CodeGraph,
  type Journey,
} from "@z1n/contracts";
import { createJourneyTools } from "./tools";
import { journeyKinds } from "./journey-kinds";

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
const TIMEOUT_MS = 8_000;
const JSON_FENCE = /^\s*```(?:json)?\s*/i;

export const JOURNEY_SYSTEM_INSTRUCTIONS =
  "You guide exploration of one analyzed source selection and explain how a feature works. " +
  "Call tools to find the feature: search_code finds strings, read_file reads lines, " +
  "get_graph_neighbors lists the verified relationships of a node with the identifiers to cite, " +
  "find_routes lists HTTP routes and their handlers. " +
  "Ground every step in tool results: cite only node identifiers that a tool returned, and never invent identifiers, files, lines or relationships. " +
  "Follow supported relationships only: calls, requests, http-route, handles, handles-event, database-access, renders. " +
  "A path explains a feature from its user-facing entry, such as a component or event handler, through requests, routes, handlers and services, to data access when the code supports it. " +
  "Stop where the analyzed evidence stops: if a request has no matching backend route, end the path there and say so in uncertainties. " +
  "If the tools cannot find the feature, return an empty steps array and explain what is missing. " +
  "The exploration has a fixed budget of six turns: after two or three tool rounds, stop calling tools and give the final answer with the best evidence you have. " +
  "After exploring, reply with JSON only and no tool calls: " +
  '{"steps":[{"nodeId":"<identifier from tools>","text":"<why this step belongs to the feature>"}],"uncertainties":["<limits such as unmatched boundaries or heuristic transitions>"]}. ' +
  "Order steps from the entry point to the result and use at most 12 steps.";
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
  })
  .strict();

function parseDraft(text: string): z.infer<typeof draftSchema> | null {
  const body = text.replace(JSON_FENCE, "").replace(/\s*```\s*$/, "");
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = draftSchema.safeParse(
      JSON.parse(body.slice(start, end + 1)),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

type Built = { journey: Journey } | { error: string };
function buildJourney(
  draft: z.infer<typeof draftSchema>,
  graph: CodeGraph,
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
    if (!byId.has(step.nodeId))
      return {
        error: `"${step.nodeId}" is not a node of this graph. Use identifiers exactly as a tool returned them.`,
      };
    if (nodeIds.includes(step.nodeId))
      return { error: `"${step.nodeId}" appears twice in the path.` };
    nodeIds.push(step.nodeId);
    explanations.push({ nodeId: step.nodeId, text: step.text });
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
      ?.map((text) => text.slice(0, 500))
      .slice(0, MAX_MODEL_UNCERTAINTIES) ?? []),
  ];
  if (!uncertainties.length)
    uncertainties.push(
      "The model reported no limitations, but a selected path is never a verified runtime trace.",
    );
  const candidate = journeySchema.parse({
    mode: "ai",
    nodeIds,
    edgeIds,
    uncertainties,
    explanations,
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
  const unknown = (message: string): Journey => ({
    mode: "ai",
    nodeIds: [],
    edgeIds: [],
    uncertainties: [message],
  });
  const tools = createJourneyTools(files, graph);
  const messages: AgentMessage[] = [{ role: "user", text: question }];
  let toolCalls = 0;
  let corrective = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let turn: AgentTurn;
    try {
      turn = await generate({
        system: JOURNEY_SYSTEM_INSTRUCTIONS,
        messages,
        tools: tools.definitions,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
          : AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return unknown(
        "The AI provider could not complete the exploration. Check the provider and model in Settings.",
      );
    }
    if (turn.kind === "tools") {
      const calls = turn.toolCalls.slice(0, MAX_TOOL_CALLS - toolCalls);
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
        const result = tools.execute(call);
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: result.name,
          content: result.output,
        });
      }
      if (toolCalls >= MAX_TOOL_CALLS) {
        messages.push({
          role: "user",
          text: "The tool budget is used up. Answer now with the final JSON and no tool calls.",
        });
      }
      continue;
    }
    const draft = parseDraft(turn.text);
    if (!draft) {
      if (corrective++) {
        return unknown(
          "The model did not return the expected JSON answer about this feature.",
        );
      }
      messages.push({ role: "assistant", text: turn.text });
      messages.push({
        role: "user",
        text: 'That answer was not valid. Reply with JSON only: {"steps":[{"nodeId":"...","text":"..."}],"uncertainties":["..."]}.',
      });
      continue;
    }
    const built = buildJourney(draft, graph);
    if ("error" in built) {
      if (corrective++) {
        return unknown(
          "The model proposed steps that the graph does not support, so no journey is shown. The static exploration mode can suggest a path by names.",
        );
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
    return journeySchema.parse({
      ...journey,
      uncertainties: journey.uncertainties.slice(0, 8),
    });
  }
  return unknown(
    "The exploration ended without a validated path. Try a more specific question or the static exploration mode.",
  );
}
