import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import type { AgentGenerate, AgentMessage, AgentTurn } from "../journey/agent";

function textOf(message: BaseMessage): string {
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
 * Presents the development-only external bridge transport as a regular chat
 * model so the orchestration graphs stay provider-neutral. The bridge is
 * never constructed in production and is not a public provider; its typed
 * failures propagate unchanged to the caller.
 */
export class DevBridgeChatModel extends BaseChatModel {
  private boundTools: unknown[] = [];

  constructor(private readonly transport: AgentGenerate) {
    super({});
  }

  _llmType(): string {
    return "external-dev-bridge";
  }

  override bindTools(tools: unknown[]): DevBridgeChatModel {
    const bound = new DevBridgeChatModel(this.transport);
    bound.boundTools = tools;
    return bound;
  }

  async _generate(
    messages: BaseMessage[],
    options?: { signal?: AbortSignal },
  ): Promise<ChatResult> {
    let system = "";
    const conversation: AgentMessage[] = [];
    for (const message of messages) {
      if (message.getType() === "system") {
        system = textOf(message);
        continue;
      }
      if (message.getType() === "human") {
        conversation.push({ role: "user", text: textOf(message) });
        continue;
      }
      if (message instanceof AIMessage) {
        const text = textOf(message);
        const toolCalls = (message.tool_calls ?? []).map((call) => ({
          id: call.id ?? call.name,
          name: call.name,
          arguments: JSON.stringify(call.args ?? {}),
        }));
        conversation.push({
          role: "assistant",
          ...(text ? { text } : {}),
          ...(toolCalls.length ? { toolCalls } : {}),
        });
        continue;
      }
      const tool = message as ToolMessage;
      conversation.push({
        role: "tool",
        toolCallId: tool.tool_call_id,
        name: tool.name ?? "",
        content: textOf(tool),
      });
    }
    const turn = (await this.transport({
      system,
      messages: conversation,
      tools: this.boundTools,
      signal: options?.signal,
    })) as AgentTurn;
    if (turn.kind === "tools")
      return {
        generations: [
          {
            text: "",
            message: new AIMessage({
              content: "",
              tool_calls: turn.toolCalls.map((call) => ({
                id: call.id,
                name: call.name,
                args: parseArguments(call.arguments),
              })),
            }),
          },
        ],
      };
    return {
      generations: [{ text: turn.text, message: new AIMessage(turn.text) }],
    };
  }
}

function parseArguments(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
