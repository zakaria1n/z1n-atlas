import type { BaseMessage } from "@langchain/core/messages";
import type { Runnable } from "@langchain/core/runnables";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import type { Provider } from "@z1n/contracts";
import { ProviderError, providerErrorForStatus } from "../providers/contracts";

// Model calls stay inside the request budget: no hidden automatic retries
// and a hard per-call wall clock. Cancellation flows through the invoke
// signal at each call site.
const MAX_RETRIES = 0;
const CALL_TIMEOUT_MS = 30_000;

/**
 * What the orchestration graphs need from a model: bind the read-only tool
 * definitions and answer a bounded conversation. All official provider
 * integrations and the development bridge adapter satisfy this.
 */
export type ToolCallingModel = {
  bindTools(tools: unknown[]): Runnable;
  invoke(
    messages: BaseMessage[],
    options?: { signal?: AbortSignal },
  ): Promise<BaseMessage>;
};

export type ChatModelInput = {
  provider: Provider;
  apiKey: string;
  model: string;
  maxOutputTokens?: number;
};

/**
 * The single place provider integrations are constructed. The official
 * LangChain adapters translate tool calling and answers for each provider,
 * so provider-specific request code is not duplicated per feature; the
 * caller's key only ever reaches the client constructor.
 */
export function createChatModel(input: ChatModelInput): ToolCallingModel {
  if (input.provider === "openai")
    return new ChatOpenAI({
      model: input.model,
      apiKey: input.apiKey,
      temperature: 0,
      maxTokens: input.maxOutputTokens,
      maxRetries: MAX_RETRIES,
      timeout: CALL_TIMEOUT_MS,
    });
  if (input.provider === "google")
    return new ChatGoogleGenerativeAI({
      model: input.model,
      apiKey: input.apiKey,
      temperature: 0,
      maxOutputTokens: input.maxOutputTokens,
      maxRetries: MAX_RETRIES,
    });
  return new ChatAnthropic({
    model: input.model,
    apiKey: input.apiKey,
    temperature: 0,
    maxTokens: input.maxOutputTokens,
    maxRetries: MAX_RETRIES,
  });
}

/**
 * Maps integration failures onto the product's typed provider errors. The
 * provider's own message or body is never copied: it can echo credentials
 * and these errors end up in HTTP responses and logs.
 */
export function providerErrorFrom(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const candidate = error as {
    status?: unknown;
    response?: { status?: unknown };
  };
  const status = candidate?.status ?? candidate?.response?.status;
  if (typeof status === "number" && status >= 400 && status < 600)
    return providerErrorForStatus(status);
  if (isAbort(error))
    return new ProviderError(
      "UNAVAILABLE",
      "The model call was cancelled or timed out.",
    );
  return new ProviderError(
    "INVALID_RESPONSE",
    "The model call could not be completed.",
  );
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.name === "TimeoutError" ||
      /abort|timed? ?out|cancel/i.test(error.message))
  );
}
