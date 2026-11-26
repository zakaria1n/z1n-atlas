import { describe, expect, it } from "vitest";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { DevBridgeChatModel } from "./dev-bridge-model";
import type { AgentMessage, AgentTurn } from "../journey/agent";

function scripted(turns: AgentTurn[], log: AgentMessage[][]) {
  return async (input: {
    system: string;
    messages: AgentMessage[];
    tools: unknown[];
    signal?: AbortSignal;
  }): Promise<AgentTurn> => {
    log.push(input.messages);
    return turns.shift() ?? { kind: "final", text: "" };
  };
}

describe("development bridge model adapter", () => {
  it("converts system and human messages for the external transport", async () => {
    const log: AgentMessage[][] = [];
    const model = new DevBridgeChatModel(
      scripted([{ kind: "final", text: "answer" }], log),
    );
    const response = await model.invoke([
      new SystemMessage("Be grounded."),
      new HumanMessage("How does login work?"),
    ]);
    expect(String(response.content)).toBe("answer");
    expect(log[0]).toEqual([{ role: "user", text: "How does login work?" }]);
  });
  it("exposes returned tool calls as a standard AI message", async () => {
    const log: AgentMessage[][] = [];
    const model = new DevBridgeChatModel(
      scripted(
        [
          {
            kind: "tools",
            toolCalls: [
              { id: "c1", name: "search_code", arguments: '{"query":"login"}' },
            ],
          },
        ],
        log,
      ),
    );
    const response = await model.invoke([new HumanMessage("Find login")]);
    expect(response).toBeInstanceOf(AIMessage);
    expect(response.tool_calls ?? []).toEqual([
      { id: "c1", name: "search_code", args: { query: "login" } },
    ]);
  });
  it("forwards tool answers and bound tools to the transport", async () => {
    const log: AgentMessage[][] = [];
    const seenTools: unknown[] = [];
    const generate = async (input: {
      system: string;
      messages: AgentMessage[];
      tools: unknown[];
    }): Promise<AgentTurn> => {
      seenTools.push(input.tools);
      log.push(input.messages);
      return log.length === 1
        ? {
            kind: "tools",
            toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }],
          }
        : { kind: "final", text: "done" };
    };
    const bound = new DevBridgeChatModel(generate).bindTools([
      { name: "read_file", description: "Read lines.", parameters: {} },
    ]);
    await bound.invoke([
      new HumanMessage("Read it"),
      new AIMessage({
        content: "",
        tool_calls: [{ id: "c1", name: "read_file", args: { path: "a.ts" } }],
      }),
      new ToolMessage({ tool_call_id: "c1", name: "read_file", content: "[]" }),
    ]);
    expect(seenTools[0]).toEqual([
      { name: "read_file", description: "Read lines.", parameters: {} },
    ]);
    expect(log[0].at(-1)).toEqual({
      role: "tool",
      toolCallId: "c1",
      name: "read_file",
      content: "[]",
    });
  });
  it("degrades malformed tool arguments to an empty object", async () => {
    const model = new DevBridgeChatModel(async () => ({
      kind: "tools",
      toolCalls: [{ id: "c1", name: "search_code", arguments: "{not json" }],
    }));
    const response = await model.invoke([new HumanMessage("Go")]);
    expect(response.tool_calls ?? []).toEqual([
      { id: "c1", name: "search_code", args: {} },
    ]);
  });
});
