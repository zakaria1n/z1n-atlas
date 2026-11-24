import { z } from "zod";
import { isEligiblePath } from "./repository/file-filter";
import {
  MAX_SOURCE_FILES,
  MAX_SOURCE_FILE_BYTES,
  MAX_SOURCE_TOTAL_BYTES,
} from "./repository/limits";

export const repositoryUrlRequestSchema = z
  .object({ url: z.string().max(500) })
  .strict();
export const sourceFileSchema = z
  .object({
    path: z.string().min(1).max(500),
    content: z.string().max(MAX_SOURCE_FILE_BYTES),
  })
  .strict();
export const analysisRequestSchema = z
  .object({
    files: z.array(sourceFileSchema).max(MAX_SOURCE_FILES),
    origin: z.enum(["github", "local"]),
    consent: z.boolean(),
  })
  .strict()
  .superRefine(({ files, origin, consent }, ctx) => {
    if (origin === "local" && !consent)
      ctx.addIssue({
        code: "custom",
        message:
          "Consent is required to send local source to the analysis server.",
        path: ["consent"],
      });
    const encoder = new TextEncoder();
    const paths = new Set<string>();
    let total = 0;
    for (const [index, file] of files.entries()) {
      const bytes = encoder.encode(file.content).length;
      total += bytes;
      if (
        !isEligiblePath(file.path) ||
        paths.has(file.path) ||
        bytes > MAX_SOURCE_FILE_BYTES
      )
        ctx.addIssue({
          code: "custom",
          message: "Invalid, duplicate, or oversized source file.",
          path: ["files", index],
        });
      paths.add(file.path);
    }
    if (total > MAX_SOURCE_TOTAL_BYTES)
      ctx.addIssue({
        code: "custom",
        message: "Source selection exceeds the total limit.",
        path: ["files"],
      });
  });
export const sourceFileWithSizeSchema = sourceFileSchema.extend({
  size: z.number().int().nonnegative().max(MAX_SOURCE_FILE_BYTES),
});
export const githubSnapshotSchema = z.object({
  repository: z.object({
    owner: z.string(),
    name: z.string(),
    url: z.string(),
  }),
  commit: z.string().regex(/^[a-f0-9]{40}$/i),
  files: z.array(sourceFileWithSizeSchema).max(MAX_SOURCE_FILES),
  skipped: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export const graphEvidenceSchema = z.object({
  id: z.string(),
  filePath: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  snippet: z.string(),
});
export const graphNodeSchema = z.object({
  id: z.string(),
  path: z.string(),
  exports: z.array(z.string()),
  kind: z
    .enum([
      "file",
      "function",
      "method",
      "class",
      "route",
      "http-call",
      "database",
      "entrypoint",
    ])
    .optional(),
  name: z.string().optional(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
});
export const graphEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  kind: z.enum([
    "imports",
    "re-exports",
    "contains",
    "calls",
    "references",
    "requests",
    "http-route",
    "handles",
    "handles-event",
    "database-access",
    "renders",
  ]),
  confidence: z.enum(["confirmed", "framework", "heuristic"]),
  evidenceId: z.string(),
  supportingEvidenceIds: z.array(z.string()).optional(),
});
export const codeGraphSchema = z.object({
  analysisId: z.uuid().optional(),
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
  evidence: z.array(graphEvidenceSchema),
  unresolved: z.number().int().nonnegative(),
  unresolvedCalls: z.number().int().nonnegative(),
  notice: z.string(),
});
export const analysisStageSchema = z.enum([
  "parsing",
  "imports",
  "symbols",
  "frameworks",
  "validating",
]);
export const analysisJobStartSchema = z.object({ jobId: z.uuid() }).strict();
export const analysisJobSchema = z.discriminatedUnion("status", [
  z
    .object({ status: z.literal("running"), stage: analysisStageSchema })
    .strict(),
  z.object({ status: z.literal("complete"), graph: codeGraphSchema }).strict(),
  z
    .object({ status: z.literal("failed"), error: z.string().max(300) })
    .strict(),
  z.object({ status: z.literal("cancelled") }).strict(),
]);
export type AnalysisJob = z.infer<typeof analysisJobSchema>;
export const apiErrorSchema = z.object({ error: z.string() });
export type AnalysisRequest = z.infer<typeof analysisRequestSchema>;
