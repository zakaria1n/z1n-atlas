import { z } from "zod";
import type { Model, ModelList, Provider } from "@z1n/contracts";
import { ProviderError, type ProviderAdapter } from "./contracts";
import { providerJson } from "./http";
const openaiResponse = z.object({
  data: z.array(z.object({ id: z.string().min(1).max(256) })).max(5000),
});
const googleResponse = z.object({
  models: z
    .array(
      z.object({
        name: z.string().min(1).max(263),
        displayName: z.string().max(256).optional(),
        supportedGenerationMethods: z.array(z.string()).optional(),
        supportedOutputTypes: z.array(z.string()).optional(),
      }),
    )
    .max(1000),
  nextPageToken: z.string().optional(),
});
const anthropicResponse = z.object({
  data: z
    .array(
      z.object({
        id: z.string().min(1).max(256),
        display_name: z.string().max(256).optional(),
        lifecycle: z.string().optional(),
      }),
    )
    .max(1000),
  has_more: z.boolean().optional(),
});
function normalize(
  models: Model[],
  partial: boolean,
  notice: string,
): ModelList {
  const unique = [
    ...new Map(models.map((model) => [model.id, model])).values(),
  ];
  return {
    models: unique.slice(0, 100),
    partial: partial || unique.length > 100,
    notice,
  };
}
export function createProviderAdapter(
  provider: Provider,
  fetcher: typeof fetch = fetch,
): ProviderAdapter {
  return {
    provider,
    async listModels(apiKey, signal) {
      if (provider === "openai") {
        const payload = await providerJson(
          "https://api.openai.com/v1/models",
          { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
          fetcher,
          signal,
        );
        const parsed = openaiResponse.safeParse(payload);
        if (!parsed.success)
          throw new ProviderError(
            "INVALID_RESPONSE",
            "The provider returned an invalid model list.",
          );
        const models = parsed.data.data
          .filter(
            (item) =>
              /^(?:gpt-|o\d)/i.test(item.id) &&
              !/(?:audio|realtime|transcrib|tts|embedding|moderation|image|search)/i.test(
                item.id,
              ),
          )
          .map((item) => ({
            id: item.id,
            label: item.id,
            compatibility: "candidate" as const,
          }));
        return normalize(
          models,
          false,
          "OpenAI model metadata does not establish text-generation compatibility or account access. Models are candidates until used.",
        );
      }
      if (provider === "google") {
        const payload = await providerJson(
          "https://generativelanguage.googleapis.com/v1beta/models?pageSize=100",
          { "x-goog-api-key": apiKey, Accept: "application/json" },
          fetcher,
          signal,
        );
        const parsed = googleResponse.safeParse(payload);
        if (!parsed.success)
          throw new ProviderError(
            "INVALID_RESPONSE",
            "The provider returned an invalid model list.",
          );
        const models = parsed.data.models
          .filter(
            (item) =>
              item.name.startsWith("models/") &&
              item.supportedGenerationMethods?.includes("generateContent") &&
              (!item.supportedOutputTypes ||
                item.supportedOutputTypes.some(
                  (type) => type.toLowerCase() === "text",
                )) &&
              !/(?:tts|audio|image|embedding|imagen|veo|live)/i.test(item.name),
          )
          .map((item) => ({
            id: item.name.slice(7),
            label: item.displayName || item.name.slice(7),
            compatibility: "advertised" as const,
          }))
          .filter((item) => item.id.length > 0 && item.id.length <= 256);
        return normalize(
          models,
          Boolean(parsed.data.nextPageToken),
          "Google advertises generation support; actual model access and text output depend on the key and model.",
        );
      }
      const payload = await providerJson(
        "https://api.anthropic.com/v1/models?limit=100",
        {
          Authorization: `Bearer ${apiKey}`,
          "anthropic-version": "2026-10-21",
          Accept: "application/json",
        },
        fetcher,
        signal,
      );
      const parsed = anthropicResponse.safeParse(payload);
      if (!parsed.success)
        throw new ProviderError(
          "INVALID_RESPONSE",
          "The provider returned an invalid model list.",
        );
      const models = parsed.data.data
        .filter(
          (item) => /^claude-/i.test(item.id) && item.lifecycle !== "retired",
        )
        .map((item) => ({
          id: item.id,
          label: item.display_name || item.id,
          compatibility: "candidate" as const,
        }));
      return normalize(
        models,
        Boolean(parsed.data.has_more),
        "Listed Claude models are candidates; generation access and capabilities depend on the key and model.",
      );
    },
  };
}
