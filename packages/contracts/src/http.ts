import { z } from "zod";
import { isEligiblePath } from "./repository/file-filter";

export const repositoryUrlRequestSchema = z
  .object({ url: z.string().max(500) })
  .strict();
export const sourceFileSchema = z
  .object({
    path: z.string().min(1).max(500),
    content: z.string().max(100_000),
  })
  .strict();
export const analysisRequestSchema = z
  .object({
    files: z.array(sourceFileSchema).max(25),
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
      if (!isEligiblePath(file.path) || paths.has(file.path) || bytes > 100_000)
        ctx.addIssue({
          code: "custom",
          message: "Invalid, duplicate, or oversized source file.",
          path: ["files", index],
        });
      paths.add(file.path);
    }
    if (total > 1_000_000)
      ctx.addIssue({
        code: "custom",
        message: "Source selection exceeds the total limit.",
        path: ["files"],
      });
  });
export const sourceFileWithSizeSchema = sourceFileSchema.extend({
  size: z.number().int().nonnegative().max(100_000),
});
export const githubSnapshotSchema = z.object({
  repository: z.object({
    owner: z.string(),
    name: z.string(),
    url: z.string(),
  }),
  commit: z.string().regex(/^[a-f0-9]{40}$/i),
  files: z.array(sourceFileWithSizeSchema).max(25),
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
    .enum(["file", "function", "method", "class", "route", "http-call"])
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
  ]),
  confidence: z.enum(["confirmed", "framework", "heuristic"]),
  evidenceId: z.string(),
  supportingEvidenceIds: z.array(z.string()).optional(),
});
export const codeGraphSchema = z.object({
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
  evidence: z.array(graphEvidenceSchema),
  unresolved: z.number().int().nonnegative(),
  notice: z.string(),
});
export const apiErrorSchema = z.object({ error: z.string() });
export type AnalysisRequest = z.infer<typeof analysisRequestSchema>;
