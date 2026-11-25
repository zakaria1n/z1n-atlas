import {
  journeyIsValid,
  journeySchema,
  type CodeGraph,
  type GraphEdge,
  type Journey,
} from "@z1n/contracts";

// Only relationships that can carry an execution or a render are followed.
// Imports and plain references say what a file knows about, not what runs.
const journeyKinds = new Set<GraphEdge["kind"]>([
  "calls",
  "requests",
  "http-route",
  "handles",
  "handles-event",
  "database-access",
  "renders",
]);
const MAX_NODES = 12;
const MAX_TERMS = 12;
const MAX_STARTS = 48;
const MAX_SEARCH_STARTS = 150;
const MAX_BRANCHES = 30;
const MAX_VISITS = 30_000;
const PREDECESSOR_DEPTH = 3;
// Layers a path may cross; the more it crosses, the more it explains.
const ENTRY = 16;
const REQUEST = 1;
const ROUTE = 2;
const LOGIC = 4;
const DATA = 8;
// How well a word of the question is matched by a name in the code.
const SAME_WORD = 3;
const INFLECTION = 2;
const RELATED_WORD = 1;

// Question words carry no meaning for the code itself.
const stopWords = new Set(
  (
    "how does do what where which when why who the and or not this that these those " +
    "with from into through for of in on at by to is are be it its as an my our me " +
    "we you can could should would please explain show tell describe understand " +
    "trace find see give work works working feature flow flows path step steps " +
    "process pipeline implement implementation app application project code " +
    "codebase system really actually just there here"
  ).split(" "),
);
// Words that name the same action or thing in different codebases. They only
// widen what counts as covering a word of the question; every relationship
// still has to exist in the graph.
const synonymGroup = new Map(
  [
    "create add new insert make generate register registration signup enroll",
    "login signin logon log authenticate authentication auth",
    "logout signout",
    "authorize authorization authorisation permission permissions",
    "update edit modify change patch",
    "delete remove destroy",
    "get fetch list load retrieve read query search lookup",
    "user account member",
    "pay payment purchase checkout order buy",
    "password passwd",
    "email mail",
    "setting settings config configuration preference preferences option options",
    "cart basket",
    "notification notify alert message",
    "upload attachment",
    "export download",
    "verify validate verification validation check",
    "approve approval confirm confirmation",
  ].flatMap((group, index) => group.split(" ").map((word) => [word, index])),
);
// Endings that do not change what a word means, longest first.
const endings = [
  "ations",
  "ation",
  "ings",
  "ing",
  "ions",
  "ion",
  "ers",
  "er",
  "ed",
  "es",
  "s",
];

/**
 * Splits a name into its words: `createUser25` becomes create, user, 25.
 * Numbers are kept however short they are, because in a name such as Item7
 * the number is what tells it apart from every other item.
 */
function words(text: string): string[] {
  return (
    text
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .match(/[a-z]+|\d+/g) ?? []
  ).filter((word) => word.length > 1 || /^\d+$/.test(word));
}
const stems = new Map<string, string>();
function stem(word: string): string {
  const cached = stems.get(word);
  if (cached !== undefined) return cached;
  let value = word;
  for (let round = 0; round < 2; round++) {
    const ending = endings.find(
      (item) => value.endsWith(item) && value.length - item.length >= 4,
    );
    if (!ending) break;
    value = value.slice(0, -ending.length);
  }
  stems.set(word, value);
  return value;
}
/**
 * How well a word of the question is matched by a word of a name: the same
 * word, an inflection of it, a word listed as related, or not at all.
 */
function matchLevel(question: string, name: string): number {
  if (/^\d+$/.test(question) || /^\d+$/.test(name))
    return question === name ? SAME_WORD : 0;
  const left = stem(question);
  const right = stem(name);
  if (left === right) return SAME_WORD;
  const [short, long] =
    left.length <= right.length ? [left, right] : [right, left];
  if (
    short.length >= 4 &&
    long.startsWith(short) &&
    long.length - short.length <= 1
  )
    return INFLECTION;
  return synonymGroup.has(question) &&
    synonymGroup.get(question) === synonymGroup.get(name)
    ? RELATED_WORD
    : 0;
}
const bitCount = (value: number) => {
  let count = 0;
  for (let rest = value; rest; rest &= rest - 1) count++;
  return count;
};
const quoted = (items: string[]) => items.map((item) => `"${item}"`).join(", ");

type Info = {
  /** Words of the question that the name of the node matches. */
  mask: number;
  matches: number;
  /** Best match level of each word of the question, in question order. */
  levels: number[];
};
type Candidate = { nodes: string[]; edges: GraphEdge[]; score: number };

/**
 * Finds the candidate static path that best explains a question. A path only
 * qualifies when it covers every word of the question, so a specific question
 * is never answered with a path from an unrelated part of the project. Every
 * step of the result is an edge of the graph.
 */
export function findJourney(
  goal: string,
  graph: CodeGraph,
  evidencePaths: string[] = [],
): Journey {
  const unknown = (message: string): Journey => ({
    mode: "static",
    nodeIds: [],
    edgeIds: [],
    uncertainties: [message],
  });
  const terms = [...new Set(words(goal))]
    .filter((word) => !stopWords.has(word))
    .slice(0, MAX_TERMS);
  if (!terms.length)
    return unknown("Name a feature, symbol or file to look for.");
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const evidence = new Set(evidencePaths);
  const pathOf = (id: string) => byId.get(id)!.path;
  // Every symbol, route and request is indexed, because a path also passes
  // through functions that do not name anything the question asks about.
  const info = new Map<string, Info>();
  let coverable = 0;
  for (const node of graph.nodes) {
    if (!node.kind || node.kind === "file") continue;
    const names = words(`${node.name ?? ""} ${node.path}`);
    const levels = terms.map((term) =>
      Math.max(0, ...names.map((name) => matchLevel(term, name))),
    );
    let mask = 0;
    levels.forEach((level, bit) => {
      if (level) mask |= 1 << bit;
    });
    coverable |= mask;
    info.set(node.id, { mask, matches: bitCount(mask), levels });
  }
  const complete = (1 << terms.length) - 1;
  const missing = terms.filter((_, bit) => !(coverable & (1 << bit)));
  if (missing.length && !evidence.size)
    return unknown(
      `No analyzed code matches ${quoted(missing)}. Try a symbol, file or feature name from the project.`,
    );
  // With AI-selected files, a node in one of those files stands in for the
  // words that no name in the code matches.
  const standIn = evidence.size ? complete & ~coverable : 0;
  const isEvidence = (id: string) => evidence.has(pathOf(id));

  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges)
    if (journeyKinds.has(edge.kind)) {
      if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
      if (!incoming.has(edge.target)) incoming.set(edge.target, []);
      outgoing.get(edge.source)!.push(edge);
      incoming.get(edge.target)!.push(edge);
    }
  // Start where the question matches, preferring the nodes that match the
  // most words, and also a few steps earlier so that a path can begin at its
  // entry point rather than in the middle.
  const starts = new Set(
    [...info]
      .filter(([id, item]) => item.mask || isEvidence(id))
      .sort((a, b) => b[1].matches - a[1].matches)
      .slice(0, MAX_STARTS)
      .map(([id]) => id),
  );
  let frontier = [...starts];
  for (let depth = 0; depth < PREDECESSOR_DEPTH; depth++) {
    const next: string[] = [];
    for (const id of frontier)
      for (const edge of incoming.get(id) ?? [])
        if (!starts.has(edge.source) && starts.size < MAX_SEARCH_STARTS) {
          starts.add(edge.source);
          next.push(edge.source);
        }
    frontier = next;
  }

  let best: Candidate | undefined;
  let visits = 0;
  function visit(
    nodes: string[],
    edges: GraphEdge[],
    covered: number,
    layers: number,
    evidenceFiles: string[],
  ) {
    if (++visits > MAX_VISITS) return;
    if (covered === complete) {
      // A path explains more when it crosses more layers, matches the words
      // of the question closely, and is longer rather than a fragment.
      const strength = terms.reduce(
        (sum, _, bit) =>
          sum + Math.max(...nodes.map((id) => info.get(id)!.levels[bit] ?? 0)),
        0,
      );
      const score =
        bitCount(layers) * 40 +
        strength * 8 +
        edges.length * 3 +
        12 * Math.min(3, evidenceFiles.length);
      if (!best || score > best.score)
        best = { nodes: [...nodes], edges: [...edges], score };
    }
    if (edges.length >= MAX_NODES - 1) return;
    for (const edge of (outgoing.get(nodes[nodes.length - 1]) ?? []).slice(
      0,
      MAX_BRANCHES,
    )) {
      if (nodes.includes(edge.target) || !info.has(edge.target)) continue;
      const kind = byId.get(edge.target)!.kind;
      visit(
        [...nodes, edge.target],
        [...edges, edge],
        covered |
          info.get(edge.target)!.mask |
          (isEvidence(edge.target) ? standIn : 0),
        layers |
          (kind === "http-call" || edge.kind === "requests" ? REQUEST : 0) |
          (kind === "route" || edge.kind === "http-route" ? ROUTE : 0) |
          (edge.kind === "calls" || edge.kind === "handles" ? LOGIC : 0) |
          (edge.kind === "database-access" ? DATA : 0),
        isEvidence(edge.target) && !evidenceFiles.includes(pathOf(edge.target))
          ? [...evidenceFiles, pathOf(edge.target)]
          : evidenceFiles,
      );
    }
  }
  for (const start of starts) {
    if (visits > MAX_VISITS) break;
    const item = info.get(start);
    if (!item) continue;
    // A path begins at an entry layer when a user or a framework starts it:
    // a component, a page, an event handler or a rendered component.
    const entered =
      byId.get(start)!.kind === "entrypoint" ||
      /\.(?:tsx|jsx)$/i.test(pathOf(start)) ||
      (outgoing.get(start) ?? []).some(
        (edge) => edge.kind === "handles-event" || edge.kind === "renders",
      );
    visit(
      [start],
      [],
      item.mask | (isEvidence(start) ? standIn : 0),
      entered ? ENTRY : 0,
      isEvidence(start) ? [pathOf(start)] : [],
    );
  }
  if (!best)
    return unknown(
      missing.length
        ? `No analyzed code matches ${quoted(missing)}, and no path in the AI-selected evidence covers the question.`
        : "No supported path matches every word of the question. Try a more specific symbol or file name.",
    );
  const { nodes, edges } = best;
  const uncertainties = [
    evidencePaths.length
      ? "This candidate static path was ranked using names and AI-selected source evidence; it is not a verified runtime trace and may be incomplete."
      : "This is a candidate static path ranked by names; it is not a verified runtime trace and may be incomplete.",
  ];
  // A word matched only through a listed related word is disclosed, because
  // the user cannot see that the code uses a different word.
  const inferred: string[] = [];
  terms.forEach((term, bit) => {
    if (
      !(coverable & (1 << bit)) ||
      nodes.some((id) => (info.get(id)?.levels[bit] ?? 0) > RELATED_WORD)
    )
      return;
    const name = nodes
      .flatMap((id) => {
        const node = byId.get(id)!;
        return words(`${node.name ?? ""} ${node.path}`);
      })
      .find((word) => matchLevel(term, word) === RELATED_WORD);
    if (name) inferred.push(`"${term}" as "${name}"`);
  });
  if (inferred.length)
    uncertainties.push(
      `Some words were matched through related names: ${inferred.join(", ")}.`,
    );
  const heuristic = edges.filter((edge) => edge.confidence === "heuristic");
  if (heuristic.length)
    uncertainties.push(
      `${heuristic.length} transition${heuristic.length > 1 ? "s are" : " is"} heuristic: the request and the backend route are a possible match, not a verified call.`,
    );
  const last = byId.get(nodes[nodes.length - 1])!;
  if (last.kind === "http-call")
    uncertainties.push(
      "No supported backend route was resolved for the final request, so the path stops at the client.",
    );
  if (last.kind === "route")
    uncertainties.push(
      "No supported handler was resolved for the final route.",
    );
  if (!edges.length)
    uncertainties.push(
      "No supported transition was found for this matching symbol.",
    );
  if (visits > MAX_VISITS)
    uncertainties.push(
      "Search reached its exploration limit; other paths may exist.",
    );
  const result = journeySchema.parse({
    mode: "static",
    nodeIds: nodes,
    edgeIds: edges.map((edge) => edge.id),
    uncertainties,
  });
  if (!journeyIsValid(result, graph))
    throw new Error("Journey contains invalid graph references.");
  return result;
}
