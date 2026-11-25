import { z } from "zod";
import { analysisRequestSchema, sourceFileSchema } from "./http";
import { providerTestRequestSchema } from "./providers";
import type { CodeGraph } from "./graph/contracts";
import { MAX_SOURCE_FILES } from "./repository/limits";
export const journeyRequestSchema = z
  .object({
    goal: z.string().trim().min(2).max(500),
    files: z.array(sourceFileSchema).max(MAX_SOURCE_FILES),
    origin: z.enum(["github", "local"]),
    consent: z.boolean(),
    analysisId: z.uuid().optional(),
    // Presence selects the AI-guided mode; absence selects static exploration.
    ai: providerTestRequestSchema
      .extend({ providerConsent: z.literal(true) })
      .optional(),
    // Requests the backend's own configured credential instead of BYOK.
    // Only honored on a development server that enabled it; the same
    // source-sharing consent applies because files still reach a provider.
    serverAi: z.boolean().optional(),
    providerConsent: z.literal(true).optional(),
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
    if (value.serverAi && !value.ai && value.providerConsent !== true)
      ctx.addIssue({
        code: "custom",
        message:
          "Server-managed AI needs the same source-sharing consent as a personal key.",
      });
    if (value.ai && value.serverAi)
      ctx.addIssue({
        code: "custom",
        message: "Choose either a personal key or the server key, not both.",
      });
  });
export const journeyModeSchema = z.enum(["ai", "static"]);
export type JourneyMode = z.infer<typeof journeyModeSchema>;
export const journeySchema = z
  .object({
    mode: journeyModeSchema,
    nodeIds: z.array(z.string().min(1).max(1000)).max(12),
    edgeIds: z.array(z.string().min(1).max(2000)).max(11),
    uncertainties: z.array(z.string().min(1).max(500)).min(1).max(8),
    /** Why each step belongs to the feature; aligned with nodeIds when present. */
    explanations: z
      .array(
        z
          .object({
            nodeId: z.string().min(1).max(1000),
            text: z.string().min(1).max(600),
          })
          .strict(),
      )
      .max(12)
      .optional(),
  })
  .strict();
export type Journey = z.infer<typeof journeySchema>;
export type JourneyRequest = z.infer<typeof journeyRequestSchema>;
export function journeyIsValid(journey: Journey, graph: CodeGraph): boolean {
  const nodes = new Set(graph.nodes.map((node) => node.id));
  if (
    !(journey.explanations ?? []).every(
      (explanation) =>
        journey.nodeIds.includes(explanation.nodeId) &&
        new Set((journey.explanations ?? []).map((item) => item.nodeId))
          .size === (journey.explanations ?? []).length,
    )
  )
    return false;
  if (!journey.nodeIds.length) return journey.edgeIds.length === 0;
  if (
    journey.edgeIds.length !== journey.nodeIds.length - 1 ||
    new Set(journey.nodeIds).size !== journey.nodeIds.length
  )
    return false;
  const edges = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const evidence = new Set(graph.evidence.map((item) => item.id));
  return (
    journey.nodeIds.every((id) => nodes.has(id)) &&
    journey.edgeIds.every((id, index) => {
      const edge = edges.get(id);
      return Boolean(
        edge &&
        evidence.has(edge.evidenceId) &&
        (edge.supportingEvidenceIds ?? []).every((item) =>
          evidence.has(item),
        ) &&
        edge.source === journey.nodeIds[index] &&
        edge.target === journey.nodeIds[index + 1],
      );
    })
  );
}
