import { Node } from "ts-morph";
import { evidence, type SymbolContext } from "./framework-graph";
import { ownerId, resolveTarget } from "./symbols-and-calls";
import { addManifestEvidence } from "./next-manifest";

export function addReactEvents(context: SymbolContext): void {
  const { graph, manifests } = context;
  for (const { path, source, jsxAttributes } of context.sources) {
    if (!/\.[jt]sx$/i.test(path)) continue;
    const reactImport = source
      .getImportDeclarations()
      .find((declaration) => declaration.getModuleSpecifierValue() === "react");
    const manifest = reactImport ? null : manifests.react(path);
    if (!reactImport && !manifest) continue;
    for (const attribute of jsxAttributes) {
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
      const sourceId = ownerId(attribute, context);
      const target = resolveTarget(expression, context);
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
