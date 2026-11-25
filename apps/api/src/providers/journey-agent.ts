import { z } from "zod";
import type { ProviderTestRequest } from "@z1n/contracts";
import { providerJson } from "./http";
import type {
  AgentGenerate,
  AgentMessage,
  AgentToolCall,
  AgentTurn,
} from "../journey/agent";
import type { JourneyToolDefinition } from "../journey/tools";

const TOOL_TIMEOUT_MS = 8_000;
const MAX_OUTPUT_TOKENS = 1_600;

const openaiResponse = z.object({
  output: z
    .array(
      z
        .object({
          type: z.string(),
          content: z
            .array(z.object({ type: z.string(), text: z.string().optional() }))
            .optional(),
          call_id: z.string().optional(),
          name: z.string().optional(),
          arguments: z.string().optional(),
        })
        .loose(),
    )
    .min(1),
});
const anthropicResponse = z.object({
  content: z
    .array(
      z
        .object({
          type: z.string(),
          text: z.string().optional(),
          id: z.string().optional(),
          name: z.string().optional(),
          input: z.unknown().optional(),
        })
        .loose(),
    )
    .min(1),
});
const googleResponse = z.object({
  candidates: z
    .array(
      z.object({
        content: z.object({
          parts: z
            .array(
              z
                .object({
                  text: z.string().optional(),
                  functionCall: z
                    .object({ name: z.string(), args: z.unknown().optional() })
                    .loose()
                    .optional(),
                })
                .loose(),
            )
            .min(1),
        }),
      }),
    )
    .min(1),
});

function parseArguments(text: string | undefined): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/**
 * Drives one provider request for the journey agent, translating the
 * provider-neutral conversation into the tool-calling format of the
 * selected provider and its answer back into a neutral turn. Each request
 * is bounded by its own timeout, so the whole loop fits the request budget.
 */
export function createJourneyAgentGenerate(
  input: ProviderTestRequest,
  fetcher: typeof fetch = fetch,
): AgentGenerate {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  return async ({ system, messages, tools, signal }): Promise<AgentTurn> => {
    const timeout = AbortSignal.timeout(TOOL_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    const request = (url: string, body: unknown) =>
      providerJson(url, headers, fetcher, combined, body, TOOL_TIMEOUT_MS);
    if (input.provider === "openai")
      return openaiTurn(input, system, messages, tools, request);
    if (input.provider === "google")
      return googleTurn(input, system, messages, tools, request);
    return anthropicTurn(input, system, messages, tools, request);
  };
}

type Request = (url: string, body: unknown) => Promise<unknown>;

async function openaiTurn(
  input: ProviderTestRequest,
  system: string,
  messages: AgentMessage[],
  tools: JourneyToolDefinition[],
  request: Request,
): Promise<AgentTurn> {
  const conversation = messages.flatMap((message): unknown[] => {
    if (message.role === "user")
      return [
        { role: "user", content: [{ type: "input_text", text: message.text }] },
      ];
    if (message.role === "assistant") {
      const items: unknown[] = [];
      if (message.text)
        items.push({
          role: "assistant",
          content: [{ type: "output_text", text: message.text }],
        });
      for (const tool of message.toolCalls ?? [])
        items.push({
          type: "function_call",
          call_id: tool.id,
          name: tool.name,
          arguments: tool.arguments,
        });
      return items;
    }
    return [
      {
        type: "function_call_output",
        call_id: message.toolCallId,
        output: message.content,
      },
    ];
  });
  const result = openaiResponse.parse(
    await request("https://api.openai.com/v1/responses", {
      model: input.model,
      instructions: system,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      tools: tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
      input: conversation,
    }),
  );
  const toolCalls: AgentToolCall[] = [];
  let text = "";
  for (const item of result.output) {
    if (item.type === "function_call" && item.name)
      toolCalls.push({
        id: item.call_id ?? item.name,
        name: item.name,
        arguments: item.arguments ?? "{}",
      });
    else if (item.type === "message")
      for (const part of item.content ?? [])
        if (part.type === "output_text" && part.text) text += part.text;
  }
  return toolCalls.length
    ? { kind: "tools", toolCalls }
    : { kind: "final", text };
}

/**
 * Google's function declarations reject JSON-Schema keywords that describe
 * object strictness (`additionalProperties`, `$schema`), so the parameters
 * are copied without them. Types, properties, items, required and enum stay
 * intact — the tool contract keeps its meaning.
 */
function googleParameters(
  parameters: unknown,
  depth = 8,
): Record<string, unknown> | undefined {
  if (!parameters || typeof parameters !== "object" || depth < 0) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (key === "additionalProperties" || key === "$schema") continue;
    if (value && typeof value === "object") {
      result[key] = Array.isArray(value)
        ? value.map((item) =>
            item && typeof item === "object" && !Array.isArray(item)
              ? googleParameters(item, depth - 1)
              : item,
          )
        : googleParameters(value, depth - 1);
    } else result[key] = value;
  }
  return result;
}

async function googleTurn(
  input: ProviderTestRequest,
  system: string,
  messages: AgentMessage[],
  tools: JourneyToolDefinition[],
  request: Request,
): Promise<AgentTurn> {
  const contents: unknown[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      contents.push({ role: "user", parts: [{ text: message.text }] });
      continue;
    }
    if (message.role === "assistant") {
      const parts: Record<string, unknown>[] = [];
      if (message.text) parts.push({ text: message.text });
      for (const tool of message.toolCalls ?? [])
        parts.push({
          functionCall: {
            name: tool.name,
            args: parseArguments(tool.arguments),
          },
        });
      contents.push({ role: "model", parts });
      continue;
    }
    // Function answers go back as parts of the next user turn.
    const previous = contents[contents.length - 1];
    const part = {
      functionResponse: {
        name: message.name,
        response: parseArguments(message.content),
      },
    };
    const last = previous as { role?: string; parts?: unknown[] } | undefined;
    if (last && last.role === "user") last.parts!.push(part);
    else contents.push({ role: "user", parts: [part] });
  }
  const result = googleResponse.parse(
    await request(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent`,
      {
        systemInstruction: { parts: [{ text: system }] },
        contents,
        tools: [
          {
            functionDeclarations: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: googleParameters(tool.parameters),
            })),
          },
        ],
        generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
      },
    ),
  );
  const parts = result.candidates[0]?.content.parts ?? [];
  const toolCalls: AgentToolCall[] = [];
  let text = "";
  parts.forEach((part, index) => {
    if (part.functionCall)
      toolCalls.push({
        id: `call_${index}`,
        name: part.functionCall.name,
        arguments: JSON.stringify(part.functionCall.args ?? {}),
      });
    else if (part.text) text += part.text;
  });
  return toolCalls.length
    ? { kind: "tools", toolCalls }
    : { kind: "final", text };
}

async function anthropicTurn(
  input: ProviderTestRequest,
  system: string,
  messages: AgentMessage[],
  tools: JourneyToolDefinition[],
  request: Request,
): Promise<AgentTurn> {
  const conversation: unknown[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      conversation.push({
        role: "user",
        content: [{ type: "text", text: message.text }],
      });
      continue;
    }
    if (message.role === "assistant") {
      const content: unknown[] = [];
      if (message.text) content.push({ type: "text", text: message.text });
      for (const tool of message.toolCalls ?? [])
        content.push({
          type: "tool_use",
          id: tool.id,
          name: tool.name,
          input: parseArguments(tool.arguments),
        });
      conversation.push({ role: "assistant", content });
      continue;
    }
    // Tool results join the following user turn, as the API requires.
    const previous = conversation[conversation.length - 1] as
      { role?: string; content?: unknown[] } | undefined;
    const block = {
      type: "tool_result",
      tool_use_id: message.toolCallId,
      content: message.content,
    };
    if (previous && previous.role === "user") previous.content!.push(block);
    else conversation.push({ role: "user", content: [block] });
  }
  const result = anthropicResponse.parse(
    await request("https://api.anthropic.com/v1/messages", {
      model: input.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      })),
      messages: conversation,
    }),
  );
  const toolCalls: AgentToolCall[] = [];
  let text = "";
  for (const block of result.content) {
    if (block.type === "tool_use" && block.name && block.id)
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      });
    else if (block.type === "text" && block.text) text += block.text;
  }
  return toolCalls.length
    ? { kind: "tools", toolCalls }
    : { kind: "final", text };
}
