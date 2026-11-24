import { z } from "zod";
import { analysisRequestSchema, sourceFileSchema } from "./http";
import { providerTestRequestSchema } from "./providers";
import type { CodeGraph } from "./graph/contracts";
export const journeyRequestSchema = z
  .object({
    goal: z.string().trim().min(2).max(500),
    files: z.array(sourceFileSchema).max(25),
    origin: z.enum(["github", "local"]),
    consent: z.boolean(),
    analysisId: z.uuid().optional(),
    ai: providerTestRequestSchema
      .extend({ providerConsent: z.literal(true) })
      .optional(),
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
  });
export const journeySchema = z
  .object({
    nodeIds: z.array(z.string().min(1).max(1000)).max(12),
    edgeIds: z.array(z.string().min(1).max(2000)).max(11),
    uncertainties: z.array(z.string().min(1).max(500)).min(1).max(8),
  })
  .strict();
export type Journey = z.infer<typeof journeySchema>;
export type JourneyRequest = z.infer<typeof journeyRequestSchema>;
export function journeyIsValid(journey: Journey, graph: CodeGraph): boolean {
  if (!journey.nodeIds.length) return journey.edgeIds.length === 0;
  if (
    journey.edgeIds.length !== journey.nodeIds.length - 1 ||
    new Set(journey.nodeIds).size !== journey.nodeIds.length
  )
    return false;
  const nodes = new Set(graph.nodes.map((node) => node.id));
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
