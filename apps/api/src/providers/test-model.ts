import { z } from "zod";
import type { ProviderTestRequest } from "@z1n/contracts";
import { ProviderError } from "./contracts";
import { providerJson } from "./http";

export async function testModel(
  input: ProviderTestRequest,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const common = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  let result: unknown;
  if (input.provider === "openai") {
    result = await providerJson(
      "https://api.openai.com/v1/responses",
      { ...common, Authorization: `Bearer ${input.apiKey}` },
      fetcher,
      signal,
      { model: input.model, input: "Reply with OK.", max_output_tokens: 32 },
    );
    const schema = z.object({
      status: z.literal("completed"),
      output: z
        .array(
          z.object({
            type: z.string(),
            content: z
              .array(
                z.object({ type: z.string(), text: z.string().optional() }),
              )
              .optional(),
          }),
        )
        .min(1),
    });
    const parsed = schema.safeParse(result);
    if (
      !parsed.success ||
      !parsed.data.output.some((item) =>
        item.content?.some(
          (part) => part.type === "output_text" && part.text?.trim(),
        ),
      )
    )
      throw new ProviderError(
        "INVALID_RESPONSE",
        "The model did not return text.",
      );
    return;
  }
  if (input.provider === "google") {
    result = await providerJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent`,
      { ...common, "x-goog-api-key": input.apiKey },
      fetcher,
      signal,
      {
        contents: [{ role: "user", parts: [{ text: "Reply with OK." }] }],
        generationConfig: { maxOutputTokens: 32 },
      },
    );
    const parsed = z
      .object({
        candidates: z
          .array(
            z.object({
              content: z.object({
                parts: z.array(z.object({ text: z.string().optional() })),
              }),
            }),
          )
          .min(1),
      })
      .safeParse(result);
    if (
      !parsed.success ||
      !parsed.data.candidates.some((candidate) =>
        candidate.content.parts.some((part) => part.text?.trim()),
      )
    )
      throw new ProviderError(
        "INVALID_RESPONSE",
        "The model did not return text.",
      );
    return;
  }
  result = await providerJson(
    "https://api.anthropic.com/v1/messages",
    {
      ...common,
      Authorization: `Bearer ${input.apiKey}`,
      "anthropic-version": "2026-10-21",
    },
    fetcher,
    signal,
    {
      model: input.model,
      max_tokens: 32,
      messages: [{ role: "user", content: "Reply with OK." }],
    },
  );
  const parsed = z
    .object({
      content: z
        .array(z.object({ type: z.string(), text: z.string().optional() }))
        .min(1),
    })
    .safeParse(result);
  if (
    !parsed.success ||
    !parsed.data.content.some(
      (part) => part.type === "text" && part.text?.trim(),
    )
  )
    throw new ProviderError(
      "INVALID_RESPONSE",
      "The model did not return text.",
    );
}
