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
  collectEvidence,
  buildChatAnswer,
  parseChatDraft,
  SYSTEM_INSTRUCTIONS,
} from "../evidence/answer";
import { registerToolResult } from "../evidence/tool-registration";
import { ToolCallingModel } from "./chat-model";

// Simple questions finish in one call; exploration is bounded so a chat
// answer can never wander: three tool rounds plus the final answer round,
// eight tool calls, one correction, all inside one overall wall clock.
const MAX_ROUNDS = 4;
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
  signal?: AbortSignal;
};

/**
 * The chat answer as an explicit state graph over the shared evidence
 * registry: deterministic retrieval first, then bounded model exploration
 * through the same read-only tools the journey uses, then claim-level
 * citation validation against the registry alone.
 */
export async function answerWithGraph(
  input: ChatGraphInput,
): Promise<ChatAnswer> {
  const { question, files, graph, model, history, signal } = input;
  const { registry, truncatedRetrieval } = collectEvidence(
    question,
    files,
    graph,
  );
  // Nothing matches: an honest abstention without spending a model call.
  if (!registry.size)
    return {
      claims: [],
      uncertainties: ["No matching evidence was found in the selected files."],
    };
  const tools = createJourneyTools(files, graph);
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

  const execute = (state: typeof ChatState.State) => {
    const last = state.messages.at(-1) as AIMessage;
    const remaining = Math.max(0, MAX_TOOL_CALLS - state.toolCallsUsed);
    const calls = (last.tool_calls ?? []).slice(0, remaining);
    const answers: BaseMessage[] = [];
    for (const call of calls) {
      const result = tools.execute({
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
    const toolCallsUsed = state.toolCallsUsed + calls.length;
    const messages: BaseMessage[] = answers;
    if (toolCallsUsed >= MAX_TOOL_CALLS)
      messages.push(
        new HumanMessage(
          "The tool budget is used up. Answer now with the final JSON and no tool calls.",
        ),
      );
    return { messages, toolCallsUsed };
  };

  const check = (state: typeof ChatState.State) => {
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
      result: buildChatAnswer(parsed.draft, registry, truncatedRetrieval),
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
    .addNode("check", check)
    .addNode("finalize", finalize)
    .addEdge(START, "explore")
    .addConditionalEdges("explore", (state: typeof ChatState.State) => {
      const last = state.messages.at(-1);
      const toolCalls =
        last instanceof AIMessage ? (last.tool_calls ?? []) : [];
      return toolCalls.length ? "execute" : "check";
    })
    .addConditionalEdges("execute", (state: typeof ChatState.State) =>
      state.rounds >= MAX_ROUNDS ? END : "explore",
    )
    .addConditionalEdges("check", (state: typeof ChatState.State) => {
      if (state.result || state.failure) return "finalize";
      return state.rounds >= MAX_ROUNDS ? END : "explore";
    })
    .addEdge("finalize", END)
    .compile();

  const state = await workflow.invoke(
    {
      messages: [
        new SystemMessage(SYSTEM_INSTRUCTIONS),
        new HumanMessage(
          JSON.stringify({
            question,
            history: history ?? [],
            evidence: registry.list(),
          }),
        ),
      ],
    },
    {
      recursionLimit: MAX_ROUNDS * 2 + 8,
      signal: AbortSignal.any([totalTimeout, ...(signal ? [signal] : [])]),
    },
  );
  if (state.result) return state.result;
  return chatAnswerSchema.parse({
    claims: [],
    uncertainties: [
      state.failure ??
        "The answer could not be validated; only verified evidence is reported.",
    ],
  });
}
