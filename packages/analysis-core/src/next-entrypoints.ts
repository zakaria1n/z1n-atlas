import { addNode, evidence, type SymbolContext } from "./framework-graph";
import { addManifestEvidence } from "./next-manifest";
import { resolveTarget, symbolId } from "./symbols-and-calls";

export function addNextEntrypoints(context: SymbolContext): number {
  let unresolved = 0;
  for (const { path, source } of context.sources) {
    if (!/(?:^|\/)app\/(?:.*\/)?page\.[jt]sx?$/i.test(path)) continue;
    const manifest = context.manifests.next(path);
    if (!manifest) {
      unresolved++;
      continue;
    }
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
    const manifestEvidenceId = addManifestEvidence(manifest, context.graph);
    const entryId = `${path}#entry:${declaration.getStart()}`,
      evidenceId = evidence(proof, context.graph);
    addNode(
      declaration,
      entryId,
      "Next.js page entry",
      "entrypoint",
      context.graph,
    );
    context.graph.edges.push({
      id: `${entryId}:contains`,
      source: path,
      target: entryId,
      kind: "contains",
      confidence: "framework",
      evidenceId,
      supportingEvidenceIds: [manifestEvidenceId],
    });
    // A page may be a nameless default export, which is a node of its own.
    const candidate = fn
      ? symbolId(fn)
      : assignment
        ? (resolveTarget(assignment.getExpression(), context) ??
          context.symbols.nodes.get(symbolId(assignment.getExpression()))?.id ??
          null)
        : null;
    if (candidate && context.graph.nodes.some((node) => node.id === candidate))
      context.graph.edges.push({
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
