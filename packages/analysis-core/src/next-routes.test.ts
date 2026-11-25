import { describe, expect, it } from "vitest";
import { analyzeFiles } from "./analyze-files";
import { graphIsValid } from "@z1n/contracts";
describe("Next.js App Router analysis", () => {
  it("links a static fetch to an exported route handler with source evidence", async () => {
    const files = [
      { path: "package.json", content: '{"dependencies":{"next":"16"}}' },
      {
        path: "src/client.ts",
        content: 'export function load(){return fetch("/api/users");}',
      },
      {
        path: "src/app/api/users/route.ts",
        content: "export async function GET(){ return Response.json([]); }",
      },
    ];
    const graph = await analyzeFiles(files);
    expect(graphIsValid(graph, files)).toBe(true);
    const edge = graph.edges.find((edge) => edge.kind === "http-route");
    expect(edge?.confidence).toBe("heuristic");
    expect(graph.nodes.find((node) => node.id === edge?.target)?.name).toBe(
      "GET /api/users",
    );
    expect(
      graph.edges.some(
        (edge) =>
          edge.kind === "handles" &&
          graph.nodes.find((node) => node.id === edge.target)?.name === "GET",
      ),
    ).toBe(true);
  });
  it("does not claim Next.js routing without a verified manifest", async () => {
    const files = [
      {
        path: "app/api/route.ts",
        content: "export function GET(){return null;}",
      },
    ];
    const graph = await analyzeFiles(files);
    expect(graph.nodes.some((node) => node.kind === "route")).toBe(false);
    expect(graph.unresolved).toBeGreaterThan(0);
  });
  it("recognizes the root API endpoint", async () => {
    const files = [
      { path: "package.json", content: '{"dependencies":{"next":"16"}}' },
      {
        path: "app/api/route.ts",
        content: "export function GET(){ return null; }",
      },
    ];
    const graph = await analyzeFiles(files);
    expect(
      graph.nodes.some(
        (node) => node.kind === "route" && node.name === "GET /api",
      ),
    ).toBe(true);
    expect(graphIsValid(graph, files)).toBe(true);
  });
  it("does not invent a match for dynamic route segments", async () => {
    const files = [
      { path: "package.json", content: '{"dependencies":{"next":"16"}}' },
      { path: "src/client.ts", content: 'fetch("/api/users/1")' },
      {
        path: "src/app/api/users/[id]/route.ts",
        content: "export function GET(){ return null; }",
      },
    ];
    const graph = await analyzeFiles(files);
    expect(graph.edges.some((edge) => edge.kind === "http-route")).toBe(false);
    expect(graph.unresolved).toBeGreaterThan(0);
    expect(graphIsValid(graph, files)).toBe(true);
  });
});
