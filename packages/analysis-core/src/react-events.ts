import { Node, SyntaxKind, type Project } from "ts-morph";
import { evidence, type GraphParts } from "./framework-graph";
import { ownerId, resolveTarget } from "./symbols-and-calls";
import { addManifestEvidence, findReactManifest } from "./next-manifest";
import type { AnalyzerFile } from "./analyze-files";

export function addReactEvents(
  project: Project,
  paths: Set<string>,
  graph: GraphParts,
  files: AnalyzerFile[],
): void {
  for (const path of paths) {
    if (!/\.[jt]sx$/i.test(path)) continue;
    const source = project.getSourceFileOrThrow(`/workspace/${path}`);
    const reactImport = source
      .getImportDeclarations()
      .find((declaration) => declaration.getModuleSpecifierValue() === "react");
    const manifest = reactImport ? null : findReactManifest(path, files);
    if (!reactImport && !manifest) continue;
    for (const attribute of source.getDescendantsOfKind(
      SyntaxKind.JsxAttribute,
    )) {
      if (!/^on[A-Z]/.test(attribute.getNameNode().getText())) continue;
      const initializer = attribute.getInitializer();
      const expression =
        initializer && Node.isJsxExpression(initializer)
          ? initializer.getExpression()
          : undefined;
      if (
        !expression ||
        !(
          Node.isIdentifier(expression) ||
          Node.isPropertyAccessExpression(expression)
        )
      )
        continue;
      const sourceId = ownerId(attribute, graph),
        target = resolveTarget(expression, graph);
      if (!target || sourceId === target || sourceId === path) continue;
      const evidenceId = evidence(attribute, graph);
      const supportingEvidenceId = reactImport
        ? evidence(reactImport, graph)
        : addManifestEvidence(manifest!, graph);
      graph.edges.push({
        id: `${evidenceId}:handles-event:${target}`,
        source: sourceId,
        target,
        kind: "handles-event",
        confidence: "framework",
        evidenceId,
        supportingEvidenceIds: [supportingEvidenceId],
      });
    }
  }
}
