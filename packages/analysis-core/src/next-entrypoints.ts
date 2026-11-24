import { addManifestEvidence, findNextManifest } from "./next-manifest";
import type { Project } from "ts-morph";
import type { AnalyzerFile } from "./analyze-files";
import { addNode, evidence, type GraphParts } from "./framework-graph";
import { resolveTarget, symbolId } from "./symbols-and-calls";

export function addNextEntrypoints(
  project: Project,
  paths: Set<string>,
  files: AnalyzerFile[],
  graph: GraphParts,
): number {
  let unresolved = 0;
  for (const filePath of paths) {
    if (!/(?:^|\/)app\/(?:.*\/)?page\.[jt]sx?$/i.test(filePath)) continue;
    const manifest = findNextManifest(filePath, files);
    if (!manifest) {
      unresolved++;
      continue;
    }
    const source = project.getSourceFileOrThrow(`/workspace/${filePath}`);
    const fn = source.getFunctions().find((item) => item.isDefaultExport());
    const assignment = source
      .getExportAssignments()
      .find((item) => !item.isExportEquals());
    const declaration = fn ?? assignment;
    if (!declaration) {
      unresolved++;
      continue;
    }
    const proof =
      fn?.getNameNode() ?? assignment?.getExpression() ?? declaration;
    const manifestEvidenceId = addManifestEvidence(manifest, graph);
    const entryId = `${filePath}#entry:${declaration.getStart()}`,
      evidenceId = evidence(proof, graph);
    addNode(declaration, entryId, "Next.js page entry", "entrypoint", graph);
    graph.edges.push({
      id: `${entryId}:contains`,
      source: filePath,
      target: entryId,
      kind: "contains",
      confidence: "framework",
      evidenceId,
      supportingEvidenceIds: [manifestEvidenceId],
    });
    const candidate = fn
      ? symbolId(fn)
      : assignment
        ? resolveTarget(assignment.getExpression(), graph)
        : null;
    if (candidate && graph.nodes.some((node) => node.id === candidate))
      graph.edges.push({
        id: `${entryId}:renders:${candidate}`,
        source: entryId,
        target: candidate,
        kind: "renders",
        confidence: "framework",
        evidenceId,
      });
    else unresolved++;
  }
  return unresolved;
}
