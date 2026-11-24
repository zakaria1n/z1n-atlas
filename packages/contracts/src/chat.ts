import { z } from "zod";
import { analysisRequestSchema, sourceFileSchema } from "./http";
import { providerTestRequestSchema } from "./providers";
export const chatRequestSchema = providerTestRequestSchema
  .extend({
    question: z.string().trim().min(2).max(1000),
    files: z.array(sourceFileSchema).max(25),
    origin: z.enum(["github", "local"]),
    consent: z.boolean(),
    providerConsent: z.literal(true),
    analysisId: z.uuid().optional(),
  })
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
