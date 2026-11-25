import { describe, expect, it } from "vitest";
import { analyzeFiles } from "./analyze-files";
import { graphIsValid } from "@z1n/contracts";
const files = [
  {
    path: "tsconfig.json",
    content: '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}',
  },
  {
    path: "src/ui.tsx",
    content:
      'import {createUser} from "@/client"; export function Form(){ return createUser(); }',
  },
  {
    path: "src/client.ts",
    content:
      'export function createUser(){ return fetch("/api/users",{method:"POST"}); }',
  },
  {
    path: "src/server.ts",
    content:
      'import express from "express"; import {router} from "./routes"; const app=express(); app.use("/api",router);',
  },
  {
    path: "src/routes.ts",
    content:
      'import {Router} from "express"; import {create} from "./controller"; export const router=Router(); router.post("/users",create);',
  },
  {
    path: "src/controller.ts",
    content:
      'import {save} from "./service"; export function create(){ return save(); }',
  },
  {
    path: "src/service.ts",
    content:
      'import {insert} from "./repo"; export function save(){ return insert(); }',
  },
  {
    path: "src/repo.ts",
    content:
      'import {db} from "./db"; export function insert(){return db.user.create({data:{name:"A"}});}',
  },
  {
    path: "src/db.ts",
    content:
      'import {PrismaClient} from "@prisma/client"; export const db = new PrismaClient();',
  },
];
describe("full-stack HTTP evidence", () => {
  it("connects a literal fetch to a mounted Express route as a heuristic with both sources", async () => {
    const graph = await analyzeFiles(files);
    const edge = graph.edges.find((e) => e.kind === "http-route");
    expect(graphIsValid(graph, files)).toBe(true);
    expect(edge?.confidence).toBe("heuristic");
    expect(graph.nodes.find((n) => n.id === edge?.source)?.name).toBe(
      "POST /api/users",
    );
    expect(graph.nodes.find((n) => n.id === edge?.target)?.name).toBe(
      "POST /api/users",
    );
    expect(edge?.supportingEvidenceIds?.length).toBe(2);
    expect(
      graph.edges.some(
        (e) =>
          e.kind === "handles" &&
          graph.nodes.find((n) => n.id === e.target)?.name === "create",
      ),
    ).toBe(true);
    const calls = graph.edges
      .filter((e) => e.kind === "calls")
      .map((e) => [
        graph.nodes.find((n) => n.id === e.source)?.name,
        graph.nodes.find((n) => n.id === e.target)?.name,
      ]);
    expect(calls).toContainEqual(["Form", "createUser"]);
    expect(calls).toContainEqual(["create", "save"]);
    expect(calls).toContainEqual(["save", "insert"]);
    const form = graph.nodes.find((n) => n.name === "Form")!;
    const next = (id: string, kind: string) =>
      graph.edges.find((e) => e.source === id && e.kind === kind)!;
    const client = next(form.id, "calls").target;
    const request = next(client, "requests").target;
    const route = next(request, "http-route").target;
    const controller = next(route, "handles").target;
    const service = next(controller, "calls").target;
    const repository = next(service, "calls").target;
    const database = next(repository, "database-access").target;
    expect(graph.nodes.find((n) => n.id === database)?.name).toBe(
      "Prisma user.create",
    );
  });
  it("does not connect an unmatched method or a dynamic URL", async () => {
    const modified = files.map((file) =>
      file.path === "src/client.ts"
        ? {
            ...file,
            content:
              'export function createUser(url: string){ fetch(url); fetch("/api/users",{method:"GET"}); }',
          }
        : file,
    );
    const graph = await analyzeFiles(modified);
    expect(graph.edges.filter((e) => e.kind === "http-route")).toEqual([]);
    expect(graph.unresolved).toBeGreaterThan(0);
    expect(graphIsValid(graph, modified)).toBe(true);
  });
  it("does not leave orphan evidence for an unused mounted router", async () => {
    const subset = files.filter((file) => file.path !== "src/routes.ts");
    const graph = await analyzeFiles(subset);
    expect(graphIsValid(graph, subset)).toBe(true);
  });
});
