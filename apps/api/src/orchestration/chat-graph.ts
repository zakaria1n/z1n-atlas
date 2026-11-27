import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  chatAnswerSchema,
  type ChatAnswer,
  type CodeGraph,
} from "@z1n/contracts";
import { createJourneyTools } from "../journey/tools";
import {
  collectEvidenceHybrid,
  buildChatAnswer,
  parseChatDraft,
  retrievalTerms,
  SYSTEM_INSTRUCTIONS,
} from "../evidence/answer";
type SemanticRetrievalState =
  import("../evidence/answer").SemanticRetrievalState;
import { registerToolResult } from "../evidence/tool-registration";
import { ToolCallingModel } from "./chat-model";

// Deterministic budgets: at most three exploration rounds with tools, eight
// tool calls, and — regardless of how the exploration ends — a reserved
// final generation round on the unbound model plus one bounded correction.
// Everything runs inside one overall wall clock.
const MAX_EXPLORE_ROUNDS = 3;
const MAX_TOOL_CALLS = 8;
const CORRECTION_LIMIT = 1;
const TIMEOUT_MS = 30_000;
const TOTAL_TIMEOUT_MS = 120_000;

const ChatState = Annotation.Root({
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
  lastRoundUseful: Annotation<boolean>({
    reducer: (_left, right) => right,
    default: () => true,
  }),
  result: Annotation<ChatAnswer | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),
  failure: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),
});

export type ChatGraphInput = {
  question: string;
  files: { path: string; content: string }[];
  graph: CodeGraph;
  model: ToolCallingModel;
  history?: { role: "user" | "assistant"; text: string }[];
  /** Repository-scoped lexical index from the snapshot cache, when available. */
  lexical?: import("../evidence/lexical-index").LexicalIndex;
  /** Cached repository context enabling the repository_overview tool. */
  context?: import("../context/builder").RepositoryContext;
  /** Optional local semantic index; when absent or unavailable, lexical only. */
  semantic?: import("../evidence/semantic-index").SemanticIndex;
  /** The snapshot's honest semantic build state when semantic is requested. */
  semanticBuildState?: "idle" | "building" | "ready" | "unavailable";
  signal?: AbortSignal;
};

const callIdentity = (name: string, args: unknown): string =>
  `${name}:${JSON.stringify(
    args && typeof args === "object" && !Array.isArray(args)
      ? Object.entries(args as Record<string, unknown>).sort(([a], [b]) =>
          a.localeCompare(b),
        )
      : (args ?? {}),
  )}`;

/**
 * The chat answer as an explicit state graph over the shared evidence
 * registry: explore with the tool-bound model, execute and register every
 * tool answer, evaluate whether the investigation is still productive,
 * then a guaranteed final generation on the unbound model, claim-level
 * citation validation, bounded correction, finish.
 */
export async function answerWithGraph(
  input: ChatGraphInput,
): Promise<ChatAnswer> {
  const {
    question,
    files,
    graph,
    model,
    history,
    signal,
    lexical,
    context,
    semantic,
    semanticBuildState,
  } = input;
  const terms = retrievalTerms(question, history);
  const {
    registry,
    truncatedRetrieval,
    semanticState: fusedState,
  } = await collectEvidenceHybrid(
    question,
    files,
    graph,
    history,
    lexical,
    semantic,
  );
  // An awaiting-but-still-building index is reported honestly instead of
  // passing as silent lexical-only retrieval.
  const semanticState: SemanticRetrievalState =
    fusedState === "hybrid"
      ? "hybrid"
      : fusedState === "unavailable"
        ? "unavailable"
        : semanticBuildState === "building"
          ? "indexing"
          : "off";
  // Genuinely empty requests — no usable term at all — abstain without a
  // model call. A meaningful question with an empty initial search is not
  // evidence of absence: it enters the graph so the model can reformulate
  // and investigate with the tools.
  if (!registry.size && !terms.length)
    return {
      claims: [],
      uncertainties: ["No matching evidence was found in the selected files."],
    };
  const recovery = !registry.size;
  const tools = createJourneyTools(files, graph, context);
  const boundModel = model.bindTools(tools.definitions);
  const totalTimeout = AbortSignal.timeout(TOTAL_TIMEOUT_MS);
  const callSignal = () =>
    AbortSignal.any([
      totalTimeout,
      ...(signal ? [signal] : []),
      AbortSignal.timeout(TIMEOUT_MS),
    ]);

  const explore = async (state: typeof ChatState.State) => {
    const response = await boundModel.invoke(state.messages, {
      signal: callSignal(),
    });
    return { messages: [response], rounds: state.rounds + 1 };
  };

  const execute = async (state: typeof ChatState.State) => {
    const last = state.messages.at(-1) as AIMessage;
    const calls = last.tool_calls ?? [];
    // Every requested call gets an answer — executed ones their result,
    // excess ones an explicit refusal — so the provider message sequence
    // stays valid no matter how the budget truncates.
    const answers: BaseMessage[] = [];
    const seen = new Set(state.seenCalls);
    let newCalls = 0;
    let answered = 0;
    for (const call of calls) {
      const identity = callIdentity(call.name, call.args);
      const withinBudget = answered < MAX_TOOL_CALLS - state.toolCallsUsed;
      if (!withinBudget) {
        answers.push(
          new ToolMessage({
            tool_call_id: call.id ?? call.name,
            name: call.name,
            content: JSON.stringify({
              notice: "The tool budget is used up; this call was not run.",
            }),
          }),
        );
        continue;
      }
      answered += 1;
      const repeated = seen.has(identity);
      seen.add(identity);
      if (!repeated) newCalls += 1;
      const result = repeated
        ? {
            name: call.name,
            output: JSON.stringify({
              notice:
                "This tool call was already answered; use the earlier result.",
            }),
          }
        : await tools.execute({
            name: call.name,
            arguments: JSON.stringify(call.args ?? {}),
          });
      // Everything the model just saw becomes citable evidence.
      registerToolResult(
        registry,
        { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        result.output,
      );
      answers.push(
        new ToolMessage({
          tool_call_id: call.id ?? call.name,
          name: result.name,
          content: result.output,
        }),
      );
    }
    return {
      messages: answers,
      toolCallsUsed: state.toolCallsUsed + answered,
      seenCalls: [...seen],
      lastRoundUseful: newCalls > 0,
    };
  };

  const evaluate = (state: typeof ChatState.State) => {
    // Continue investigating only while rounds, tool budget and novelty all
    // allow it; otherwise the reserved final generation must start.
    const canExplore =
      state.rounds < MAX_EXPLORE_ROUNDS &&
      state.toolCallsUsed < MAX_TOOL_CALLS &&
      state.lastRoundUseful;
    if (canExplore) return "explore";
    return "generate";
  };

  const generate = async (state: typeof ChatState.State) => {
    // Final generation happens on the unbound model: no tools are offered,
    // so the last round can never be consumed by another tool request.
    const answer = await model.invoke(
      [
        ...state.messages,
        new HumanMessage(
          recovery
            ? "Answer now with the final JSON and no tool calls. If the tools found nothing citable, return claims: [] and say in uncertainties what was searched and remains unknown."
            : "Answer now with the final JSON and no tool calls.",
        ),
      ],
      { signal: callSignal() },
    );
    return { messages: [answer] };
  };

  const validate = (state: typeof ChatState.State) => {
    const last = state.messages.at(-1) as AIMessage;
    const parsed = parseChatDraft(last.text);
    if ("error" in parsed) {
      if (state.corrective >= CORRECTION_LIMIT)
        return {
          failure:
            "The model response could not be validated against the available evidence.",
        };
      return {
        messages: [
          last,
          new HumanMessage(
            `${parsed.error} Reply with JSON only: {"claims":[{"text":"...","evidenceIds":["..."]}],"uncertainties":["..."]}.`,
          ),
        ],
        corrective: state.corrective + 1,
      };
    }
    return {
      result: buildChatAnswer(
        parsed.draft,
        registry,
        truncatedRetrieval,
        semanticState,
      ),
    };
  };

  const finalize = (state: typeof ChatState.State): { result: ChatAnswer } => {
    if (state.result) return { result: state.result };
    return {
      result: chatAnswerSchema.parse({
        claims: [],
        uncertainties: [
          state.failure ??
            "The answer could not be validated; only verified evidence is reported.",
        ],
      }),
    };
  };

  const workflow = new StateGraph(ChatState)
    .addNode("explore", explore)
    .addNode("execute", execute)
    .addNode("generate", generate)
    .addNode("validate", validate)
    .addNode("finalize", finalize)
    .addEdge(START, "explore")
    .addConditionalEdges("explore", (state: typeof ChatState.State) => {
      const last = state.messages.at(-1);
      const toolCalls =
        last instanceof AIMessage ? (last.tool_calls ?? []) : [];
      return toolCalls.length ? "execute" : "validate";
    })
    .addConditionalEdges("execute", (state: typeof ChatState.State) =>
      evaluate(state),
    )
    .addEdge("generate", "validate")
    .addConditionalEdges("validate", (state: typeof ChatState.State) => {
      if (state.result || state.failure) return "finalize";
      return "generate";
    })
    .addEdge("finalize", END)
    .compile();

  const opening = [
    new SystemMessage(
      recovery
        ? `${SYSTEM_INSTRUCTIONS} The initial retrieval found no matching evidence for the question. That is not proof of absence: reformulate the question (synonyms, identifiers, related concepts) and use the search tools to investigate the selection before answering.`
        : SYSTEM_INSTRUCTIONS,
    ),
    new HumanMessage(
      JSON.stringify({
        question,
        history: history ?? [],
        evidence: registry.list(),
      }),
    ),
  ];
  const state = await workflow.invoke(
    { messages: opening },
    {
      recursionLimit: MAX_EXPLORE_ROUNDS * 2 + CORRECTION_LIMIT * 2 + 8,
      signal: AbortSignal.any([totalTimeout, ...(signal ? [signal] : [])]),
    },
  );
  if (state.result) return state.result;
  return chatAnswerSchema.parse({
    claims: [],
    uncertainties: [
      state.failure ??
        (recovery
          ? "No matching evidence was found in the selected files."
          : "The answer could not be validated; only verified evidence is reported."),
    ],
  });
}
