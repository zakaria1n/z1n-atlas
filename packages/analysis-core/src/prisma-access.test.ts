import { describe, expect, it } from "vitest";
import { graphIsValid } from "@z1n/contracts";
import { analyzeFiles } from "./analyze-files";
describe("Prisma source evidence", () => {
  it("links a recognized client operation through an imported instance", () => {
    const files = [
      {
        path: "src/db.ts",
        content:
          'import {PrismaClient} from "@prisma/client"; export const db = new PrismaClient();',
      },
      {
        path: "src/repo.ts",
        content:
          'import {db} from "./db"; export function insert(data: unknown){return db.user.create({data});}',
      },
    ];
    const graph = analyzeFiles(files),
      edge = graph.edges.find((item) => item.kind === "database-access");
    expect(graphIsValid(graph, files)).toBe(true);
    expect(edge?.confidence).toBe("framework");
    expect(graph.nodes.find((node) => node.id === edge?.target)?.name).toBe(
      "Prisma user.create",
    );
    expect(graph.nodes.find((node) => node.id === edge?.source)?.name).toBe(
      "insert",
    );
    expect(edge?.supportingEvidenceIds).toHaveLength(2);
  });
  it("does not infer database access from unrelated similarly named objects", () => {
    const graph = analyzeFiles([
      {
        path: "src/a.ts",
        content:
          "const db = { user: {create:()=>1} }; export function f(){return db.user.create();}",
      },
    ]);
    expect(graph.edges.some((edge) => edge.kind === "database-access")).toBe(
      false,
    );
  });
});
