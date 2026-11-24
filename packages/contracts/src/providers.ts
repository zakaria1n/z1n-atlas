import { z } from "zod";
export const providerSchema = z.enum(["openai", "google", "anthropic"]);
export const providerRequestSchema = z
  .object({
    provider: providerSchema,
    apiKey: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[^\s\x00-\x1f\x7f]+$/),
  })
  .strict();
export const modelSchema = z
  .object({
    id: z.string().min(1).max(256),
    label: z.string().min(1).max(256),
    compatibility: z.enum(["advertised", "candidate"]),
  })
  .strict();
export const modelListSchema = z
  .object({
    models: z.array(modelSchema).max(100),
    partial: z.boolean(),
    notice: z.string().max(500),
  })
  .strict();
export const providerTestRequestSchema = providerRequestSchema.extend({
  model: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[a-zA-Z0-9._:-]+$/),
});
export const providerTestResultSchema = z
  .object({ ok: z.literal(true) })
  .strict();
export type Provider = z.infer<typeof providerSchema>;
export type ProviderRequest = z.infer<typeof providerRequestSchema>;
export type Model = z.infer<typeof modelSchema>;
export type ModelList = z.infer<typeof modelListSchema>;
export type ProviderTestRequest = z.infer<typeof providerTestRequestSchema>;
