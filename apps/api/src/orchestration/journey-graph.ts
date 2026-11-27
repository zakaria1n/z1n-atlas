import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  journeyIsValid,
  journeySchema,
  type CodeGraph,
  type Journey,
} from "@z1n/contracts";
import { createJourneyTools } from "../journey/tools";
import { ToolCallingModel } from "./chat-model";
import {
  JOURNEY_SYSTEM_INSTRUCTIONS,
  buildJourney,
  parseDraft,
} from "../journey/agent";
import { completePersistenceEvidence } from "../journey/complete-evidence";
import { groundExplanations } from "../journey/claims";

// The same deterministic budgets as before the LangGraph migration: rounds
// bound every model call, tool calls and corrections are separately capped,
// and each model round gets a wall clock inside one overall timeout.
const MAX_ROUNDS = 6;
const MAX_TOOL_CALLS = 18;
const TIMEOUT_MS = 30_000;
const TOTAL_TIMEOUT_MS = 180_000;
const CORRECTION_LIMIT = 2;

const JourneyState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  rounds: Annotation<number>({
    reducer: (_left, right) => right,
    default: () => 0,
  }),
  toolCallsUsed: Annotation<number>({
    reducer: (_left, right) => right,
    default: () => 0,
  }),
  corrective: Annotation<number>({
    reducer: (_left, right) => right,
    default: () => 0,
  }),
  seenCalls: Annotation<string[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  partial: Annotation<Journey | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),
  journey: Annotation<Journey | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),
  failure: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),
});

export type JourneyGraphInput = {
  question: string;
  files: { path: string; content: string }[];
  graph: CodeGraph;
  model: ToolCallingModel;
  /** Cached repository context enabling the repository_overview tool. */
  context?: import("../context/builder").RepositoryContext;
  signal?: AbortSignal;
  maxRounds?: number;
  maxToolCalls?: number;
};

/**
 * The bounded exploration loop as an explicit state graph: explore with the
 * bound model, execute its tool calls, validate every proposed identifier
 * against the graph, and apply bounded corrections. The edges of the
 * returned journey always come from the graph itself; the model chooses
 * only what to inspect.
 */
export async function runJourneyAgent(
  input: JourneyGraphInput,
): Promise<Journey> {
  const { question, files, graph, model, signal, context } = input;
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
  const tools = createJourneyTools(files, graph, context);
  const totalTimeout = AbortSignal.timeout(TOTAL_TIMEOUT_MS);
  const callSignal = () =>
    AbortSignal.any([
      totalTimeout,
      ...(signal ? [signal] : []),
      AbortSignal.timeout(TIMEOUT_MS),
    ]);
  // Salvaged prefixes survive a recursion stop, matching the previous loop.
  let salvaged: Journey | undefined;
  const unknown = (message: string): Journey =>
    unknownJourney(salvaged, message);
  try {
    const boundModel = model.bindTools(tools.definitions);

    const explore = async (state: typeof JourneyState.State) => {
      const response = await boundModel.invoke(state.messages, {
        signal: callSignal(),
      });
      return { messages: [response], rounds: state.rounds + 1 };
    };

    const execute = (state: typeof JourneyState.State) => {
      const last = state.messages.at(-1) as AIMessage;
      const remaining = Math.max(0, maxToolCalls - state.toolCallsUsed);
      const calls = (last.tool_calls ?? []).slice(0, remaining);
      const seen = new Set(state.seenCalls);
      const answers: BaseMessage[] = [];
      for (const call of calls) {
        const key = callKey(call.name, call.args);
        const repeated = seen.has(key);
        seen.add(key);
        const result = repeated
          ? {
              name: call.name,
              output: JSON.stringify({
                notice:
                  "This tool call was already answered; use the earlier result.",
              }),
            }
          : tools.execute({
              name: call.name,
              arguments: JSON.stringify(call.args ?? {}),
            });
        answers.push(
          new ToolMessage({
            tool_call_id: call.id ?? call.name,
            name: result.name,
            content: result.output,
          }),
        );
      }
      const toolCallsUsed = state.toolCallsUsed + calls.length;
      const messages: BaseMessage[] = answers;
      if (toolCallsUsed >= maxToolCalls)
        messages.push(
          new HumanMessage(
            "The tool budget is used up. Answer now with the final JSON and no tool calls.",
          ),
        );
      return { messages, toolCallsUsed, seenCalls: [...seen] };
    };

    const check = (state: typeof JourneyState.State) => {
      const last = state.messages.at(-1) as AIMessage;
      const parsed = parseDraft(last.text);
      if ("error" in parsed) {
        if (state.corrective >= CORRECTION_LIMIT)
          return {
            failure:
              "The model did not return the expected JSON answer about this feature.",
          };
        return {
          messages: [
            last,
            new HumanMessage(
              `${parsed.error} Reply with JSON only: {"steps":[{"nodeId":"...","text":"..."}],"relatedOperations":[{"ownerId":"...","nodeId":"..."}],"uncertainties":["..."]}. Keep each step under 600 characters and each uncertainty under 500.`,
            ),
          ],
          corrective: state.corrective + 1,
        };
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
            const best =
              !salvaged ||
              prefix.journey.nodeIds.length > salvaged.nodeIds.length
                ? prefix.journey
                : salvaged;
            salvaged = best;
            break;
          }
        }
        if (state.corrective >= CORRECTION_LIMIT)
          return {
            failure: `Invalid journey: ${built.error.slice(0, 400)}`,
            partial: salvaged,
          };
        return {
          messages: [
            last,
            new HumanMessage(`Your answer was rejected: ${built.error}`),
          ],
          corrective: state.corrective + 1,
          partial: salvaged,
        };
      }
      return { journey: built.journey };
    };

    const finalize = (
      state: typeof JourneyState.State,
    ): { journey: Journey } => {
      if (state.journey) {
        const journey = journeySchema.parse(state.journey);
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
          return {
            journey: unknownJourney(
              state.partial,
              "The additional evidence could not be validated.",
            ),
          };
        const grounded = groundExplanations(completed, graph, files);
        if (!journeyIsValid(grounded, graph, files))
          return {
            journey: unknownJourney(
              state.partial,
              "The explanation evidence could not be verified.",
            ),
          };
        return {
          journey: journeySchema.parse({
            ...grounded,
            uncertainties: grounded.uncertainties.slice(0, 8),
          }),
        };
      }
      return {
        journey: unknownJourney(
          state.partial,
          state.failure ??
            "The exploration ended without a validated path. Try a more specific question or the static exploration mode.",
        ),
      };
    };

    const workflow = new StateGraph(JourneyState)
      .addNode("explore", explore)
      .addNode("execute", execute)
      .addNode("check", check)
      .addNode("finalize", finalize)
      .addEdge(START, "explore")
      .addConditionalEdges("explore", (state: typeof JourneyState.State) => {
        const last = state.messages.at(-1);
        const toolCalls =
          last instanceof AIMessage ? (last.tool_calls ?? []) : [];
        return toolCalls.length ? "execute" : "check";
      })
      .addConditionalEdges("execute", (state: typeof JourneyState.State) =>
        state.rounds >= maxRounds ? END : "explore",
      )
      .addConditionalEdges("check", (state: typeof JourneyState.State) => {
        if (state.journey || state.failure) return "finalize";
        return state.rounds >= maxRounds ? END : "explore";
      })
      .addEdge("finalize", END)
      .compile();

    const state = await workflow.invoke(
      {
        messages: [
          new SystemMessage(JOURNEY_SYSTEM_INSTRUCTIONS),
          new HumanMessage(question),
        ],
      },
      {
        recursionLimit: maxRounds * 2 + 8,
        signal: AbortSignal.any([totalTimeout, ...(signal ? [signal] : [])]),
      },
    );
    if (state.journey) return state.journey;
    return unknown(
      state.failure ??
        "The exploration ended without a validated path. Try a more specific question or the static exploration mode.",
    );
  } catch {
    return unknown(
      "The AI provider could not complete the exploration. Check the provider and model in Settings.",
    );
  }
}

function unknownJourney(
  partial: Journey | undefined,
  message: string,
): Journey {
  return partial
    ? {
        ...partial,
        uncertainties: [
          ...partial.uncertainties.slice(0, 6),
          "This is a partial path; later proposed steps could not be validated.",
          message,
        ],
      }
    : { mode: "ai", nodeIds: [], edgeIds: [], uncertainties: [message] };
}

/** Same call identity as before the migration, so repeats stay detectable. */
function callKey(name: string, args: unknown): string {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const entries = Object.entries(args as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    return `${name}:${JSON.stringify(entries)}`;
  }
  return `${name}:${JSON.stringify(args ?? {})}`;
}
