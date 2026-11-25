import { z } from "zod";
import { analysisRequestSchema, sourceFileSchema } from "./http";
import { providerTestRequestSchema } from "./providers";
import { MAX_SOURCE_FILES } from "./repository/limits";
export const chatRequestSchema = z
  .object({
    question: z.string().trim().min(2).max(1000),
    files: z.array(sourceFileSchema).max(MAX_SOURCE_FILES),
    origin: z.enum(["github", "local"]),
    consent: z.boolean(),
    providerConsent: z.literal(true),
    analysisId: z.uuid().optional(),
    // The personal key (BYOK) or the backend's development credential.
    // Exactly one of the two selects how the request is served.
    ai: providerTestRequestSchema
      .extend({ providerConsent: z.literal(true) })
      .optional(),
    serverAi: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      !analysisRequestSchema.safeParse({
        files: value.files,
        origin: value.origin,
        consent: value.consent,
      }).success
    )
      ctx.addIssue({
        code: "custom",
        message: "Invalid source selection or missing consent.",
      });
    if (value.ai && value.serverAi)
      ctx.addIssue({
        code: "custom",
        message: "Choose either a personal key or the server key, not both.",
      });
    if (!value.ai && !value.serverAi)
      ctx.addIssue({
        code: "custom",
        message: "Choose a provider or the server-managed key.",
      });
  });
export type ChatRequest = z.infer<typeof chatRequestSchema>;
export const citationSchema = z
  .object({
    id: z.string().min(1).max(2000),
    filePath: z.string().min(1).max(500),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    snippet: z.string().max(1000),
    relationship: z
      .object({
        edgeId: z.string().max(2000),
        source: z.string().max(1000),
        target: z.string().max(1000),
        kind: z.string().max(50),
        confidence: z.enum(["confirmed", "framework", "heuristic"]),
      })
      .strict()
      .optional(),
  })
  .strict();
export const chatAnswerSchema = z
  .object({
    claims: z
      .array(
        z
          .object({
            text: z.string().min(1).max(1200),
            citations: z.array(citationSchema).min(1).max(5),
          })
          .strict(),
      )
      .max(8),
    uncertainties: z.array(z.string().min(1).max(500)).max(8),
  })
  .strict();
export type ChatAnswer = z.infer<typeof chatAnswerSchema>;
