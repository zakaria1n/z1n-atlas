import MiniSearch from "minisearch";
import type { CodeGraph } from "@z1n/contracts";

type Source = { path: string; content: string };

/**
 * One tokenizer for code and natural language: camelCase identifiers split
 * into words, snake_case and qualified names split on separators, so a
 * query like "user registration" reaches `handleRegister` and a query like
 * "journeyIsValid" reaches prose that says "journey is valid".
 */
export const codeTokenizer = (text: string): string[] =>
  text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.$@/-]/g, " ")
    .toLowerCase()
    .match(/[a-z0-9]{2,}/g) ?? [];

export type LexicalHit = {
  nodeId: string;
  path: string;
  startLine: number;
  endLine: number;
  name: string | null;
  kind: string | null;
  score: number;
};

/**
 * An in-memory indexed index over the analyzed selection's symbols: paths,
 * names and a bounded source excerpt each. Build cost is linear in the
 * graph; queries are sub-millisecond, replacing full-corpus scans per term.
 */
export function createLexicalIndex(files: Source[], graph: CodeGraph) {
  const linesOf = new Map(
    files.map((file) => [file.path, file.content.split(/\r\n|\r|\n/)]),
  );
  const meta = new Map<string, { node: CodeGraph["nodes"][number] }>();
  const documents = graph.nodes.map((node, position) => {
    const lines = linesOf.get(node.path);
    const excerpt = node.startLine
      ? (lines ?? [])
          .slice(
            node.startLine - 1,
            Math.min(node.endLine ?? node.startLine, node.startLine + 12),
          )
          .join(" ")
          .slice(0, 600)
      : node.path;
    const id = `${node.id}#${position}`;
    meta.set(id, { node });
    return {
      id,
      path: node.path,
      name: node.name ?? "",
      kind: node.kind ?? "file",
      excerpt,
    };
  });
  const index = new MiniSearch({
    fields: ["path", "name", "excerpt"],
    storeFields: ["path"],
    tokenize: codeTokenizer,
    processTerm: (term) => (term.length >= 2 ? term : null),
  });
  index.addAll(documents);
  return {
    search(question: string, limit = 10): LexicalHit[] {
      const terms = [...new Set(codeTokenizer(question))].slice(0, 8);
      if (!terms.length) return [];
      // Natural-language questions use forms the code rarely does
      // ("registration" versus RegisterForm): loose stems combined with
      // prefix matching close that gap without an index-side stemmer.
      const stems = terms.map((term) =>
        term.replace(/(?:ations?|ings?|ed|es|s)$/, ""),
      );
      const query = [...new Set([...terms, ...stems])].slice(0, 16).join(" ");
      return index
        .search(query, { prefix: true, fuzzy: 0.1 })
        .slice(0, limit)
        .flatMap((hit) => {
          const entry = meta.get(String(hit.id));
          if (!entry) return [];
          return [
            {
              nodeId: entry.node.id,
              path: entry.node.path,
              startLine: entry.node.startLine ?? 1,
              endLine: entry.node.endLine ?? entry.node.startLine ?? 1,
              name: entry.node.name ?? null,
              kind: entry.node.kind ?? null,
              score: hit.score,
            },
          ];
        });
    },
  };
}

export type LexicalIndex = ReturnType<typeof createLexicalIndex>;
