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
/**
 * How strongly the backend could support an explanation, in decreasing
 * order. `source` means every meaningful code fragment the explanation
 * cites was found verbatim in the analyzed file; `partial` means some
 * cited fragments were verified while other meaningful citations in the
 * same statement were not found, so the whole statement is only partially
 * supported; `relationship` means a verified graph edge backs it;
 * `heuristic` means the backing edge is itself a heuristic match;
 * `inference` means nothing mechanical supports the statement and it must
 * be read as the model's interpretation.
 */
export const supportLevelSchema = z.enum([
  "source",
  "partial",
  "relationship",
  "heuristic",
  "inference",
]);
export type SupportLevel = z.infer<typeof supportLevelSchema>;
export const explanationSupportSchema = z
  .object({
    level: supportLevelSchema,
    /** Analyzed-file ranges whose text contains the cited fragment verbatim. */
    sourceRefs: z
      .array(
        z
          .object({
            path: z.string().min(1).max(500),
            startLine: z.number().int().min(1),
            endLine: z.number().int().min(1),
            fragment: z.string().min(1).max(120),
          })
          .strict(),
      )
      .max(3)
      .optional(),
    /** Verified graph edges that back the statement. */
    edgeIds: z.array(z.string().min(1).max(2000)).max(3).optional(),
    /** Generated limitation, e.g. a heuristic match or conditional rollback. */
    note: z.string().min(1).max(300).optional(),
  })
  .strict();
export type ExplanationSupport = z.infer<typeof explanationSupportSchema>;
export const journeySchema = z
  .object({
    mode: journeyModeSchema,
    nodeIds: z.array(z.string().min(1).max(1000)).max(12),
    edgeIds: z.array(z.string().min(1).max(2000)).max(11),
    uncertainties: z.array(z.string().min(1).max(500)).min(1).max(8),
    relatedOperations: z
      .array(
        z
          .object({
            ownerId: z.string().min(1).max(1000),
            nodeId: z.string().min(1).max(1000),
            edgeId: z.string().min(1).max(2000),
          })
          .strict(),
      )
      .max(24)
      .optional(),
    /** Why each step belongs to the feature; aligned with nodeIds when present. */
    explanations: z
      .array(
        z
          .object({
            nodeId: z.string().min(1).max(1000),
            text: z.string().min(1).max(600),
            /** Backend-verified support classification of this explanation. */
            support: explanationSupportSchema.optional(),
          })
          .strict(),
      )
      .max(12)
      .optional(),
  })
  .strict();
export type Journey = z.infer<typeof journeySchema>;
export type JourneyRequest = z.infer<typeof journeyRequestSchema>;
const relationshipKinds = new Set([
  "calls",
  "requests",
  "http-route",
  "handles",
  "handles-event",
  "database-access",
  "renders",
]);
export function journeyIsValid(
  journey: Journey,
  graph: CodeGraph,
  files?: { path: string; content: string }[],
): boolean {
  const nodes = new Set(graph.nodes.map((node) => node.id));
  const edges = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const evidence = new Set(graph.evidence.map((item) => item.id));
  const operations = journey.relatedOperations ?? [];
  if (new Set(operations.map((item) => item.edgeId)).size !== operations.length)
    return false;
  if (
    !operations.every((item) => {
      const edge = edges.get(item.edgeId);
      const node = graph.nodes.find(
        (candidate) => candidate.id === item.nodeId,
      );
      return Boolean(
        journey.nodeIds.includes(item.ownerId) &&
        node?.kind === "database" &&
        edge?.kind === "database-access" &&
        edge.source === item.ownerId &&
        edge.target === item.nodeId &&
        evidence.has(edge.evidenceId) &&
        (edge.supportingEvidenceIds ?? []).every((id) => evidence.has(id)),
      );
    })
  )
    return false;
  const fileLines = new Map(
    (files ?? []).map((file) => [file.path, file.content.split(/\r\n|\r|\n/)]),
  );
  if (
    !(journey.explanations ?? []).every((explanation) => {
      if (
        !journey.nodeIds.includes(explanation.nodeId) ||
        new Set((journey.explanations ?? []).map((item) => item.nodeId))
          .size !== (journey.explanations ?? []).length
      )
        return false;
      const support = explanation.support;
      if (!support) return true;
      // A claimed strength must match what actually backs the statement.
      if (support.level === "source" && !support.sourceRefs?.length)
        return false;
      if (
        (support.level === "relationship" || support.level === "heuristic") &&
        !support.edgeIds?.length
      )
        return false;
      if (
        support.level === "heuristic" &&
        !support.edgeIds?.every(
          (id) => edges.get(id)?.confidence === "heuristic",
        )
      )
        return false;
      if (
        support.edgeIds &&
        !support.edgeIds.every((id) => {
          const edge = edges.get(id);
          return (
            edge &&
            relationshipKinds.has(edge.kind) &&
            (edge.source === explanation.nodeId ||
              edge.target === explanation.nodeId)
          );
        })
      )
        return false;
      return (support.sourceRefs ?? []).every((reference) => {
        const fileLine = fileLines.get(reference.path);
        const inGraph =
          nodes.has(reference.path) ||
          graph.nodes.some((node) => node.path === reference.path);
        if (!inGraph || reference.endLine < reference.startLine) return false;
        if (!fileLine) return true;
        if (reference.endLine > fileLine.length) return false;
        return fileLine
          .slice(reference.startLine - 1, reference.endLine)
          .join("\n")
          .includes(reference.fragment);
      });
    })
  )
    return false;
  if (!journey.nodeIds.length) return journey.edgeIds.length === 0;
  if (
    journey.edgeIds.length !== journey.nodeIds.length - 1 ||
    new Set(journey.nodeIds).size !== journey.nodeIds.length
  )
    return false;
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
