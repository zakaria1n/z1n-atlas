import { Parser, Language, type Tree } from "web-tree-sitter";
import type { AnalyzerFile } from "../analyze-files";

let parserPromise: Promise<Parser> | null = null;

/**
 * The shared tree-sitter runtime for Python. The parser ships as WebAssembly,
 * so analysis never builds native code and never runs the analyzed project;
 * the grammar itself is the MIT-licensed tree-sitter-python grammar.
 */
export function pythonParser(): Promise<Parser> {
  parserPromise ??= (async () => {
    await Parser.init({
      locateFile: (file: string) => require.resolve(`web-tree-sitter/${file}`),
    });
    const language = await Language.load(
      require.resolve("tree-sitter-wasms/out/tree-sitter-python.wasm"),
    );
    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
  })();
  return parserPromise;
}

export type ParsedPython = {
  path: string;
  source: string;
  tree: Tree;
  /** Offsets of the line breaks, so string positions become line numbers fast. */
  breaks: number[];
};

export async function parsePythonFiles(
  files: AnalyzerFile[],
): Promise<ParsedPython[]> {
  const parser = await pythonParser();
  return files.map((file) => {
    const tree = parser.parse(file.content);
    if (!tree)
      throw new Error(`The Python file ${file.path} could not be parsed.`);
    const breaks: number[] = [];
    for (
      let index = file.content.indexOf("\n");
      index !== -1;
      index = file.content.indexOf("\n", index + 1)
    )
      breaks.push(index);
    return { path: file.path, source: file.content, tree, breaks };
  });
}

/** The 1-based line a start offset is on. */
export function lineOf(file: ParsedPython, start: number): number {
  let low = 0;
  let high = file.breaks.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (file.breaks[middle] < start) low = middle + 1;
    else high = middle;
  }
  return low + 1;
}

export function spanOf(file: ParsedPython, start: number, end: number) {
  return {
    startLine: lineOf(file, start),
    endLine: lineOf(file, Math.max(start, end - 1)),
    snippet: file.source.slice(start, end),
  };
}
