import { describe, expect, it, vi } from "vitest";
import type { ProviderTestRequest } from "@z1n/contracts";
import { ProviderError } from "./contracts";
import { createJourneyAgentGenerate } from "./journey-agent";
import type { JourneyToolDefinition } from "../journey/tools";

const input: ProviderTestRequest = {
  provider: "openai",
  apiKey: "test-key",
  model: "demo",
};
const tools: JourneyToolDefinition[] = [
  {
    name: "search_code",
    description: "Search the analyzed source.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "A search query." },
      },
      required: ["query"],
      additionalProperties: false,
      $schema: "https://json-schema.org/draft/2020-12/schema",
    },
  },
];
const system = "Explore and answer with JSON.";

function provider(providerName: ProviderTestRequest["provider"]) {
  return { ...input, provider: providerName };
}
type CapturedRequest = {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
};
function mockFetcher(responses: unknown[]) {
  const requests: CapturedRequest[] = [];
  const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
    requests.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    const payload = responses[requests.length - 1];
    if (typeof payload === "number")
      return new Response("denied", { status: payload });
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetcher, requests };
}

describe("journey tool-calling adapters", () => {
  it("translates OpenAI function calls and their answers", async () => {
    const { fetcher, requests } = mockFetcher([
      {
        output: [
          {
            type: "function_call",
            call_id: "c1",
            name: "search_code",
            arguments: '{"query":"login"}',
          },
        ],
      },
      {
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "done" }],
          },
        ],
      },
    ]);
    const generate = createJourneyAgentGenerate(provider("openai"), fetcher);
    const first = await generate({
      system,
      messages: [{ role: "user", text: "How does login work?" }],
      tools,
    });
    expect(first).toEqual({
      kind: "tools",
      toolCalls: [
        { id: "c1", name: "search_code", arguments: '{"query":"login"}' },
      ],
    });
    expect(requests[0].url).toBe("https://api.openai.com/v1/responses");
    // The caller key must authenticate every round of the exploration.
    expect(requests[0].headers.authorization).toBe("Bearer test-key");
    expect(requests[0].body.instructions).toBe(system);
    expect(requests[0].body.tools[0]).toMatchObject({
      type: "function",
      name: "search_code",
      description: "Search the analyzed source.",
    });
    await generate({
      system,
      messages: [
        { role: "user", text: "How does login work?" },
        {
          role: "assistant",
          toolCalls: [
            { id: "c1", name: "search_code", arguments: '{"query":"login"}' },
          ],
        },
        { role: "tool", toolCallId: "c1", name: "search_code", content: "[]" },
      ],
      tools,
    });
    expect(requests[1].body.input).toContainEqual({
      type: "function_call_output",
      call_id: "c1",
      output: "[]",
    });
  });
  it("translates Anthropic tool_use blocks and tool results", async () => {
    const { fetcher, requests } = mockFetcher([
      {
        content: [
          {
            type: "tool_use",
            id: "tu1",
            name: "search_code",
            input: { query: "login" },
          },
        ],
      },
      { content: [{ type: "text", text: "final answer" }] },
    ]);
    const generate = createJourneyAgentGenerate(provider("anthropic"), fetcher);
    const first = await generate({
      system,
      messages: [{ role: "user", text: "How does login work?" }],
      tools,
    });
    expect(first).toEqual({
      kind: "tools",
      toolCalls: [
        { id: "tu1", name: "search_code", arguments: '{"query":"login"}' },
      ],
    });
    expect(requests[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(requests[0].headers["x-api-key"]).toBe("test-key");
    expect(requests[0].headers["anthropic-version"]).toBe("2023-06-01");
    expect(requests[0].body.system).toBe(system);
    expect(requests[0].body.tools[0].input_schema).toEqual(tools[0].parameters);
    const second = await generate({
      system,
      messages: [
        { role: "user", text: "How does login work?" },
        {
          role: "assistant",
          toolCalls: [
            { id: "tu1", name: "search_code", arguments: '{"query":"login"}' },
          ],
        },
        { role: "tool", toolCallId: "tu1", name: "search_code", content: "[]" },
      ],
      tools,
    });
    expect(second).toEqual({ kind: "final", text: "final answer" });
    const lastMessage = requests[1].body.messages.at(-1) as {
      role: string;
      content: { type: string; tool_use_id: string }[];
    };
    expect(lastMessage.role).toBe("user");
    expect(lastMessage.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tu1",
    });
  });
  it("translates Gemini function calls with declarations and responses", async () => {
    const { fetcher, requests } = mockFetcher([
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: "search_code",
                    args: { query: "login" },
                  },
                },
              ],
            },
          },
        ],
      },
      {
        candidates: [{ content: { parts: [{ text: "gemini done" }] } }],
      },
    ]);
    const generate = createJourneyAgentGenerate(provider("google"), fetcher);
    const first = await generate({
      system,
      messages: [{ role: "user", text: "How does login work?" }],
      tools,
    });
    expect(first).toEqual({
      kind: "tools",
      toolCalls: [
        { id: "call_0", name: "search_code", arguments: '{"query":"login"}' },
      ],
    });
    expect(requests[0].url).toContain(
      "generativelanguage.googleapis.com/v1beta/models/demo:generateContent",
    );
    expect(requests[0].body.systemInstruction.parts[0].text).toBe(system);
    expect(requests[0].headers["x-goog-api-key"]).toBe("test-key");
    expect(requests[0].body.tools[0].functionDeclarations[0].name).toBe(
      "search_code",
    );
    await generate({
      system,
      messages: [
        { role: "user", text: "How does login work?" },
        {
          role: "assistant",
          toolCalls: [
            {
              id: "call_0",
              name: "search_code",
              arguments: '{"query":"login"}',
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call_0",
          name: "search_code",
          content: '{"matches":[]}',
        },
      ],
      tools,
    });
    const contents = requests[1].body.contents as {
      role: string;
      parts: Record<string, unknown>[];
    }[];
    const answered = contents.find((content) =>
      content.parts.some((part) => "functionResponse" in part),
    );
    expect(answered?.parts[0].functionResponse).toMatchObject({
      name: "search_code",
      response: { matches: [] },
    });
    // Google rejects JSON-Schema strictness keywords in its function
    // declarations; the rest of the schema must arrive untouched.
    const body = JSON.stringify(requests[0].body);
    expect(body).not.toContain("additionalProperties");
    expect(body).not.toContain("$schema");
    expect(
      requests[0].body.tools[0].functionDeclarations[0].parameters,
    ).toMatchObject({
      type: "object",
      properties: { query: { type: "string", description: "A search query." } },
      required: ["query"],
    });
  });
  it("maps provider rejection to a typed error", async () => {
    const { fetcher } = mockFetcher([401]);
    const generate = createJourneyAgentGenerate(provider("openai"), fetcher);
    await expect(
      generate({
        system,
        messages: [{ role: "user", text: "How does login work?" }],
        tools,
      }),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});
