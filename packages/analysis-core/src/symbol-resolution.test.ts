import { describe, expect, it } from "vitest";
import { graphIsValid } from "@z1n/contracts";
import { analyzeFiles } from "./analyze-files";

const files = [
  {
    path: "core.ts",
    content:
      "export function createItem() {}\nexport const removeItem = () => {};\n",
  },
  {
    path: "bridge.ts",
    content:
      "export { createItem as makeItem, removeItem as dropItem } from './core';\n",
  },
  { path: "space.ts", content: "export * from './core';\n" },
  {
    path: "thing.ts",
    content: `export class Thing {
  submit = () => {};
  #reset() {}
  [Symbol.iterator]() {}
  run() {
    this.submit();
    this.#reset();
  }
}
`,
  },
  {
    path: "use.ts",
    content: `import { makeItem, dropItem } from './bridge';
import * as space from './space';
import { Thing } from './thing';

const other = { makeItem: 1, createItem: 2 };

/** {@link createItem} is only mentioned in a comment. */
export function start() {
  makeItem();
  dropItem;
  space.createItem;
  other.makeItem;
  other.createItem;
  const list = [...new Thing()];
  return list;
}
`,
  },
];
const edgesBetween = (
  kind: string,
  from: string,
  to: string,
  content = files,
) => {
  const graph = analyzeFiles(content);
  expect(graphIsValid(graph, content)).toBe(true);
  return graph.edges.filter((edge) => {
    const node = (id: string) => graph.nodes.find((item) => item.id === id);
    return (
      edge.kind === kind &&
      node(edge.source)?.name === from &&
      node(edge.target)?.name === to
    );
  });
};

describe("symbol resolution through aliases and members", () => {
  it("links references and calls that reach a declaration through an import or re-export alias", () => {
    expect(edgesBetween("calls", "start", "createItem")).toHaveLength(1);
    expect(edgesBetween("references", "start", "removeItem")).toHaveLength(1);
    expect(edgesBetween("references", "start", "Thing")).toHaveLength(1);
  });
  it("resolves members reached through a namespace import, this and a private name", () => {
    expect(edgesBetween("references", "start", "createItem")).toHaveLength(1);
    expect(edgesBetween("calls", "run", "submit")).toHaveLength(1);
    expect(edgesBetween("calls", "run", "#reset")).toHaveLength(1);
  });
  it("does not link object properties that merely share an imported name", () => {
    const content = files.map((file) =>
      file.path === "use.ts"
        ? {
            ...file,
            content: file.content
              .replace("  makeItem();\n", "")
              .replace("  dropItem;\n", "")
              .replace("  space.createItem;\n", ""),
          }
        : file,
    );
    expect(
      edgesBetween("references", "start", "createItem", content),
    ).toHaveLength(0);
    expect(
      edgesBetween("references", "start", "removeItem", content),
    ).toHaveLength(0);
  });
  it("does not derive relationships from comments", () => {
    // Only the call site mentions createItem as code; the comment adds none.
    const content = files.map((file) =>
      file.path === "use.ts"
        ? { ...file, content: file.content.replace("  makeItem();\n", "") }
        : file,
    );
    expect(
      edgesBetween("references", "start", "createItem", content),
    ).toHaveLength(1);
    const withoutProperty = content.map((file) =>
      file.path === "use.ts"
        ? {
            ...file,
            content: file.content.replace("  space.createItem;\n", ""),
          }
        : file,
    );
    expect(
      edgesBetween("references", "start", "createItem", withoutProperty),
    ).toHaveLength(0);
  });
  it("keeps a method with a computed name as a node", () => {
    const graph = analyzeFiles(files);
    expect(graph.nodes.map((node) => node.name)).toContain("[Symbol.iterator]");
  });
});
