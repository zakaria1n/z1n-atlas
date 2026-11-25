import type { ProviderTestRequest } from "@z1n/contracts";
import { providerJson } from "./http";

/**
 * Probes a model with a trivial function declaration, because catalogues list
 * text generation and tool use separately: a model can answer plain prompts
 * while refusing the tool calling the AI-guided journey depends on. Success
 * requires an accepted request; the model may reply with text or a call.
 */
export async function probeToolCalling(
  input: ProviderTestRequest,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const common = { "Content-Type": "application/json" };
  if (input.provider === "google") {
    await providerJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent`,
      { ...common, "x-goog-api-key": input.apiKey },
      fetcher,
      signal,
      {
        systemInstruction: {
          parts: [{ text: "You are a code explorer." }],
        },
        contents: [{ role: "user", parts: [{ text: "Search for bookings." }] }],
        tools: [
          {
            functionDeclarations: [
              {
                name: "search_code",
                description: "Search the analyzed source.",
                parameters: {
                  type: "object",
                  properties: { query: { type: "string" } },
                  required: ["query"],
                },
              },
            ],
          },
        ],
        generationConfig: { maxOutputTokens: 64 },
      },
    );
    return;
  }
  if (input.provider === "anthropic") {
    await providerJson(
      "https://api.anthropic.com/v1/messages",
      {
        ...common,
        "x-api-key": input.apiKey,
        "anthropic-version": "2023-06-01",
      },
      fetcher,
      signal,
      {
        model: input.model,
        max_tokens: 64,
        tools: [
          {
            name: "search_code",
            description: "Search the analyzed source.",
            input_schema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
        ],
        messages: [{ role: "user", content: "Search for bookings." }],
      },
    );
    return;
  }
  await providerJson(
    "https://api.openai.com/v1/responses",
    { ...common, Authorization: `Bearer ${input.apiKey}` },
    fetcher,
    signal,
    {
      model: input.model,
      max_output_tokens: 64,
      tools: [
        {
          type: "function",
          name: "search_code",
          description: "Search the analyzed source.",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      ],
      input: "Search for bookings.",
    },
  );
}
