import { z } from "zod";
import type { ProviderTestRequest } from "@z1n/contracts";
import type { AnswerContext } from "../evidence/answer";
import { ProviderError } from "./contracts";
import { providerJson } from "./http";

export async function generateAnswer(
  input: ProviderTestRequest,
  context: AnswerContext,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  const common = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const content = JSON.stringify({
    question: context.question,
    evidence: context.evidence,
  });
  let text: string | undefined;
  if (input.provider === "openai") {
    const result = await providerJson(
      "https://api.openai.com/v1/responses",
      { ...common, Authorization: `Bearer ${input.apiKey}` },
      fetcher,
      signal,
      {
        model: input.model,
        instructions: context.system,
        input: content,
        max_output_tokens: 1500,
      },
    );
    const parsed = z
      .object({
        output: z.array(
          z.object({
            content: z
              .array(
                z.object({ type: z.string(), text: z.string().optional() }),
              )
              .optional(),
          }),
        ),
      })
      .safeParse(result);
    text = parsed.success
      ? parsed.data.output
          .flatMap((item) => item.content ?? [])
          .find((part) => part.type === "output_text")?.text
      : undefined;
  } else if (input.provider === "google") {
    const result = await providerJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent`,
      { ...common, "x-goog-api-key": input.apiKey },
      fetcher,
      signal,
      {
        systemInstruction: { parts: [{ text: context.system }] },
        contents: [{ role: "user", parts: [{ text: content }] }],
        generationConfig: {
          maxOutputTokens: 1500,
          responseMimeType: "application/json",
        },
      },
    );
    const parsed = z
      .object({
        candidates: z.array(
          z.object({
            content: z.object({
              parts: z.array(z.object({ text: z.string().optional() })),
            }),
          }),
        ),
      })
      .safeParse(result);
    text = parsed.success
      ? parsed.data.candidates[0]?.content.parts.find((part) => part.text)?.text
      : undefined;
  } else {
    const result = await providerJson(
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
        system: context.system,
        max_tokens: 1500,
        messages: [{ role: "user", content }],
      },
    );
    const parsed = z
      .object({
        content: z.array(
          z.object({ type: z.string(), text: z.string().optional() }),
        ),
      })
      .safeParse(result);
    text = parsed.success
      ? parsed.data.content.find((part) => part.type === "text")?.text
      : undefined;
  }
  if (!text)
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
