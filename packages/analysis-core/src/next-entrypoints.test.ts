import { describe, expect, it } from "vitest";
import { analyzeFiles } from "./analyze-files";
import { graphIsValid } from "@z1n/contracts";
describe("Next.js entrypoints", () => {
  it("links a package-backed page entry to its real default component", async () => {
    const files = [
      { path: "package.json", content: '{"dependencies":{"next":"1"}}' },
      {
        path: "src/app/page.tsx",
        content: "export default function Home(){return null;}",
      },
    ];
    const graph = await analyzeFiles(files);
    const edge = graph.edges.find((edge) => edge.kind === "renders");
    expect(edge?.confidence).toBe("framework");
    expect(graph.nodes.find((node) => node.id === edge?.target)?.name).toBe(
      "Home",
    );
    expect(graphIsValid(graph, files)).toBe(true);
  });
  it("does not label an arbitrary app/page file as a Next.js entry without a manifest", async () => {
    const graph = await analyzeFiles([
      {
        path: "src/app/page.tsx",
        content: "export default function Home(){return null;}",
      },
    ]);
    expect(graph.nodes.some((node) => node.kind === "entrypoint")).toBe(false);
  });
});
