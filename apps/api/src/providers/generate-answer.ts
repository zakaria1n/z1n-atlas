import {
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { ProviderTestRequest } from "@z1n/contracts";
import type { AnswerContext } from "../evidence/answer";
import { ProviderError } from "./contracts";
import {
  createChatModel,
  providerErrorFrom,
  type ToolCallingModel,
} from "../orchestration/chat-model";

const CHAT_MAX_OUTPUT_TOKENS = 1500;

function answerText(message: BaseMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((block) =>
      block && typeof block === "object" && "text" in block
        ? String(block.text)
        : "",
    )
    .join("");
}

/**
 * One shared model call for the chat answer: the provider integrations own
 * the request format, the answer is parsed into the evidence draft here.
 */
export async function generateAnswer(
  input: ProviderTestRequest,
  context: AnswerContext,
  signal?: AbortSignal,
  model: Pick<ToolCallingModel, "invoke"> = createChatModel({
    provider: input.provider,
    apiKey: input.apiKey,
    model: input.model,
    maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS,
  }),
): Promise<unknown> {
  let text: string;
  try {
    const response = await model.invoke(
      [
        new SystemMessage(context.system),
        new HumanMessage(
          JSON.stringify({
            question: context.question,
            history: context.history ?? [],
            evidence: context.evidence,
          }),
        ),
      ],
      { signal },
    );
    text = answerText(response);
  } catch (error) {
    throw providerErrorFrom(error);
  }
  if (!text.trim())
    throw new ProviderError(
      "INVALID_RESPONSE",
      "The provider did not return a text answer.",
    );
  try {
    return JSON.parse(
      text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""),
    );
  } catch {
    return null;
  }
}
