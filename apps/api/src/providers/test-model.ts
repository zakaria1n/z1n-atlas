import { HumanMessage } from "@langchain/core/messages";
import type { ProviderTestRequest } from "@z1n/contracts";
import { ProviderError } from "./contracts";
import {
  createChatModel,
  providerErrorFrom,
  type ToolCallingModel,
} from "../orchestration/chat-model";

const PROBE_MAX_OUTPUT_TOKENS = 32;

/**
 * The smallest live request that proves the key, the model and basic text
 * generation work; used by the Settings connection test.
 */
export async function testModel(
  input: ProviderTestRequest,
  signal?: AbortSignal,
  model: Pick<ToolCallingModel, "invoke"> = createChatModel({
    provider: input.provider,
    apiKey: input.apiKey,
    model: input.model,
    maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
  }),
): Promise<void> {
  let text: string;
  try {
    const response = await model.invoke([new HumanMessage("Reply with OK.")], {
      signal,
    });
    text =
      typeof response.content === "string"
        ? response.content
        : response.content
            .map((block) =>
              block && typeof block === "object" && "text" in block
                ? String(block.text)
                : "",
            )
            .join("");
  } catch (error) {
    throw providerErrorFrom(error);
  }
  if (!text.trim())
    throw new ProviderError(
      "INVALID_RESPONSE",
      "The model did not return text.",
    );
}
