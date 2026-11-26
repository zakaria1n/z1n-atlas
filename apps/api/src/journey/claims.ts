import type {
  CodeGraph,
  ExplanationSupport,
  Journey,
  SupportLevel,
} from "@z1n/contracts";
type Source = { path: string; content: string };
type Explanation = NonNullable<Journey["explanations"]>[number];

/** Wording that claims more than static analysis can establish. */
const certaintyClaim =
  /\b(confirmed|proven|guaranteed|guarantees|verified at runtime|runtime[- ]verified|always (?:runs|executes|calls|commits|rolls back)|every (?:call|request|execution|path))\b/i;
const persistenceCall =
  /\b(?:commits?|committing|flush(?:es|ed)?|rolls? back|rolled back|rollback)\b/i;
const absenceClaim =
  /\b(?:no|never|cannot|does not|doesn't)\b.{0,40}\b(?:exist|exists|mechanism|feature|support|supported|notify|notification|send|sent|receive)\b/i;

/**
 * Extracts the code fragments an explanation cites: quoted spans, dotted
 * expressions and called names of at least four characters. Quoted spans
 * and dotted expressions are meaningful assertions — their absence from the
 * analyzed file weakens the statement; a bare call name is only a hint.
 * Every fragment is later measured verbatim against the analyzed file;
 * unmatched ones are never treated as proof.
 */
function citedFragments(
  text: string,
): { fragment: string; meaningful: boolean }[] {
  const fragments = new Map<string, boolean>();
  for (const match of text.matchAll(/[`"']([^`"']{4,80})[`"']/g))
    fragments.set(match[1].trim(), true);
  for (const match of text.matchAll(
    /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b/g,
  ))
    fragments.set(match[0], true);
  for (const match of text.matchAll(/\b([A-Za-z_$][\w$]{3,})\s*\(/g))
    if (!fragments.has(`${match[1]}(`)) fragments.set(`${match[1]}(`, false);
  return [...fragments]
    .map(([fragment, meaningful]) => ({ fragment, meaningful }))
    .filter((item) => item.fragment.length >= 4)
    .slice(0, 6);
}

/** The analyzed-file range that contains a fragment verbatim, if any. */
function locateFragment(
  fragment: string,
  path: string,
  lines: string[],
): {
  path: string;
  startLine: number;
  endLine: number;
  fragment: string;
} | null {
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].includes(fragment)) continue;
    let end = index + 1;
    while (
      end < lines.length &&
      end - index < 3 &&
      lines[end].includes(fragment)
    )
      end++;
    return {
      path,
      startLine: index + 1,
      endLine: end,
      fragment: fragment.slice(0, 120),
    };
  }
  // Folded code: models quote calls the source splits across lines, so a
  // whitespace-insensitive window match is accepted as the same fragment.
  const needle = fragment.replace(/\s+/g, "");
  if (needle.length < 4) return null;
  for (let index = 0; index < lines.length; index++) {
    for (let span = 1; span <= 4 && index + span <= lines.length; span++) {
      const window = lines
        .slice(index, index + span)
        .join("")
        .replace(/\s+/g, "");
      if (window.includes(needle))
        return {
          path,
          startLine: index + 1,
          endLine: index + span,
          fragment: fragment.slice(0, 120),
        };
    }
  }
  return null;
}

/**
 * Classifies one explanation against the graph and the analyzed files. The
 * classification is computed here, never taken from the model: a statement
 * whose cited fragment is absent from the analyzed file is an inference, a
 * statement backed only by a heuristic edge stays heuristic, and wording
 * that claims confirmed runtime behavior is qualified in place. Nothing
 * here proves unrestricted natural language true — it only measures what
 * the recorded evidence actually covers.
 */
function groundExplanation(
  explanation: Explanation,
  journey: Journey,
  graph: CodeGraph,
  fileLines: Map<string, string[]>,
): Explanation {
  const node = graph.nodes.find((item) => item.id === explanation.nodeId);
  if (!node) return explanation;
  let text = explanation.text;
  // The verified transitions of the path that touch this node.
  const pathEdges = journey.edgeIds
    .map((id) => graph.edges.find((edge) => edge.id === id))
    .filter(
      (edge) =>
        edge &&
        (edge.source === explanation.nodeId ||
          edge.target === explanation.nodeId),
    );
  const heuristicEdges = pathEdges.filter(
    (edge) => edge!.confidence === "heuristic",
  );
  const supportedEdges = pathEdges.filter(
    (edge) => edge!.confidence !== "heuristic",
  );
  // Cited fragments: the model's own wording is measured against the file.
  // Partial support is judged on meaningful citations (quoted spans and
  // dotted expressions); a bare call name that matches nothing is a hint,
  // not a failed assertion.
  const sourceRefs: ExplanationSupport["sourceRefs"] = [];
  const missingMeaningful: string[] = [];
  for (const { fragment, meaningful } of citedFragments(text)) {
    const lines = fileLines.get(node.path);
    const located = lines ? locateFragment(fragment, node.path, lines) : null;
    if (
      located &&
      located.startLine <= (node.endLine ?? 0) + 2 &&
      located.endLine >= (node.startLine ?? 1) - 2
    ) {
      sourceRefs.push(located);
    } else if (meaningful) {
      missingMeaningful.push(fragment);
    }
    if (sourceRefs.length >= 3) break;
  }
  const edgeIds = (heuristicEdges.length ? heuristicEdges : supportedEdges)
    .slice(0, 2)
    .map((edge) => edge!.id);
  // The weakest relevant support wins: a heuristic transition is never
  // silently upgraded, even when the model also quotes real code, and a
  // statement with both verified and missing citations is only partially
  // supported — never presented as fully verified.
  let level: SupportLevel;
  if (heuristicEdges.length) level = "heuristic";
  else if (sourceRefs.length && missingMeaningful.length) level = "partial";
  else if (sourceRefs.length) level = "source";
  else if (supportedEdges.length) level = "relationship";
  else level = "inference";
  const notes: string[] = [];
  if (level === "heuristic")
    notes.push(
      "The transition to this step is a heuristic URL and method match, not a verified call.",
    );
  if (level === "partial")
    notes.push(
      `Partially supported: ${missingMeaningful
        .map((fragment) => `\`${fragment}\``)
        .join(
          " and ",
        )} was not found in the analyzed file; the remainder of the statement rests on the verified citation(s) and the rest is the model's interpretation.`,
    );
  if (level === "inference")
    notes.push(
      "No cited code fragment or verified relationship supports this statement; treat it as the model's interpretation.",
    );
  if (certaintyClaim.test(text) && level !== "source" && level !== "partial")
    text = `[Static analysis — not runtime-verified] ${text}`;
  if (
    persistenceCall.test(text) &&
    /\b(always|every|each|whenever|guaranteed)\b/i.test(text)
  )
    notes.push(
      "The function contains this persistence call; source presence does not prove it executes on every path — branches may skip it or roll back.",
    );
  if (absenceClaim.test(text))
    notes.push(
      "Absence of matched results is not evidence of absence; only the searched selection was examined.",
    );
  const support: ExplanationSupport = {
    level,
    ...(sourceRefs.length ? { sourceRefs } : {}),
    ...(level === "relationship" || level === "heuristic" ? { edgeIds } : {}),
    ...(notes.length ? { note: notes.join(" ").slice(0, 300) } : {}),
  };
  return { ...explanation, text, support };
}

/**
 * Grounds every journey explanation in mechanically verified evidence:
 * cited fragments are located in the analyzed files, backing edges are the
 * verified path edges, and overconfident wording is qualified in place. The
 * validated journey path is never changed — grounding only annotates and
 * qualifies explanations, so useful paths are never discarded.
 */
export function groundExplanations(
  journey: Journey,
  graph: CodeGraph,
  files: Source[],
): Journey {
  if (!journey.explanations?.length) return journey;
  const fileLines = new Map(
    files.map((file) => [file.path, file.content.split(/\r\n|\r|\n/)]),
  );
  const explanations = journey.explanations.map((explanation) =>
    groundExplanation(explanation, journey, graph, fileLines),
  );
  // The caller already validated the journey; grounding only annotates it.
  return { ...journey, explanations } as Journey;
}
