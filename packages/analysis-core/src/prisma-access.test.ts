import { describe, expect, it } from "vitest";
import { graphIsValid } from "@z1n/contracts";
import { analyzeFiles } from "./analyze-files";
describe("Prisma source evidence", () => {
  it("links a recognized client operation through an imported instance", async () => {
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
    const graph = await analyzeFiles(files),
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
  it("does not infer database access from unrelated similarly named objects", async () => {
    const graph = await analyzeFiles([
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
  it("detects operations through a singleton factory that constructs the client", async () => {
    const graph = await analyzeFiles([
      {
        path: "src/db.ts",
        content:
          'import { PrismaClient } from "@prisma/client";\nfunction makeClient(){ return { client: new PrismaClient() }; }\nexport const db = makeClient().client;',
      },
      {
        path: "src/app.ts",
        content:
          'import { db } from "./db";\nfunction load(id: string){ return db.user.findUnique({ where: { id } }); }',
      },
    ]);
    const edge = graph.edges.find((item) => item.kind === "database-access");
    expect(edge).toBeTruthy();
    expect(graph.nodes.find((node) => node.id === edge?.target)?.name).toBe(
      "Prisma user.findUnique",
    );
  });
});

describe("Prisma in monorepo selections with package aliases", () => {
  it("resolves a package-level alias import to the singleton factory", async () => {
    // Monorepo shape: the root tsconfig defines no aliases; the app's own
    // tsconfig maps "@/lib/*". The prisma singleton sits behind a logical
    // expression (`global.prisma ?? factory()`), as real apps ship it.
    const files = [
      {
        path: "tsconfig.json",
        content: '{"compilerOptions":{"moduleResolution":"bundler"}}',
      },
      {
        path: "apps/web/tsconfig.json",
        content:
          '{"compilerOptions":{"baseUrl":".","paths":{"@/lib/*":["lib/*"]}}}',
      },
      {
        path: "apps/web/lib/prisma.ts",
        content:
          'import {PrismaClient} from "@prisma/client";\n' +
          "const prismaClientSingleton = () => new PrismaClient({log: []});\n" +
          "declare global { var prisma: unknown | undefined; }\n" +
          "export const prisma = global.prisma ?? prismaClientSingleton();",
      },
      {
        path: "apps/web/app/route.ts",
        content:
          'import {prisma} from "@/lib/prisma";\n' +
          "export async function GET() {\n" +
          "  const users = await prisma.user.findMany();\n" +
          "  return Response.json(users);\n" +
          "}",
      },
    ];
    const graph = await analyzeFiles(files);
    const edge = graph.edges.find((item) => item.kind === "database-access");
    expect(graphIsValid(graph, files)).toBe(true);
    expect(edge?.confidence).toBe("framework");
    expect(graph.nodes.find((node) => node.id === edge?.target)?.name).toBe(
      "Prisma user.findMany",
    );
    expect(graph.nodes.find((node) => node.id === edge?.source)?.name).toBe(
      "GET",
    );
  });
});
