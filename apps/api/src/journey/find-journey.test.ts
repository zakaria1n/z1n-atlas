import { describe, expect, it } from "vitest";
import { analyzeFiles } from "@z1n/analysis-core";
import { graphIsValid, journeyIsValid } from "@z1n/contracts";
import { findJourney } from "./find-journey";
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
describe("feature journey selection", () => {
  it("prefers a matching registered handler over an unrelated handler for the same endpoint", async () => {
    const changed = files.map((file) =>
      file.path === "src/ui.tsx"
        ? {
            ...file,
            content: `import React from 'react'; import {createUser} from '@/client'; export function Form(){ const handleRegister = () => createUser(); const demo = () => createUser(); return <><form onSubmit={handleRegister}/><button onClick={demo}/></>; }`,
          }
        : file,
    );
    const graph = await analyzeFiles(changed);
    const journey = findJourney("user registration", graph);
    expect(journeyIsValid(journey, graph)).toBe(true);
    expect(
      journey.nodeIds
        .slice(0, 2)
        .map((id) => graph.nodes.find((node) => node.id === id)?.name),
    ).toEqual(["Form", "handleRegister"]);
    expect(
      graph.edges.find((edge) => edge.id === journey.edgeIds[0])?.kind,
    ).toBe("handles-event");
  });
  it("uses evidence-selected files only as ranking hints for real graph paths", async () => {
    const graph = await analyzeFiles(files);
    const journey = findJourney("payment", graph, ["src/ui.tsx"]);
    expect(journeyIsValid(journey, graph)).toBe(true);
    expect(journey.nodeIds.length).toBeGreaterThan(1);
    expect(journey.uncertainties.join()).toContain(
      "AI-selected source evidence",
    );
    expect(
      journey.edgeIds.every((id) => graph.edges.some((edge) => edge.id === id)),
    ).toBe(true);
  });
  it("selects a real path from React through Express to Prisma with a heuristic warning", async () => {
    const graph = await analyzeFiles(files);
    const journey = findJourney("How does user registration work?", graph);
    expect(graphIsValid(graph, files)).toBe(true);
    expect(journeyIsValid(journey, graph)).toBe(true);
    expect(
      journey.nodeIds.map(
        (id) => graph.nodes.find((node) => node.id === id)?.name,
      ),
    ).toEqual([
      "Form",
      "createUser",
      "POST /api/users",
      "POST /api/users",
      "create",
      "save",
      "insert",
      "Prisma user.create",
    ]);
    expect(journey.uncertainties.join()).toContain("heuristic");
  });
  it("does not invent an unmatched route", async () => {
    const changed = files.map((file) =>
      file.path === "src/client.ts"
        ? {
            ...file,
            content:
              'export function createUser(){ return fetch("/api/missing",{method:"POST"}); }',
          }
        : file,
    );
    const graph = await analyzeFiles(changed);
    const journey = findJourney("user registration", graph);
    expect(journeyIsValid(journey, graph)).toBe(true);
    expect(
      journey.edgeIds.map(
        (id) => graph.edges.find((edge) => edge.id === id)?.kind,
      ),
    ).not.toContain("http-route");
    expect(journey.uncertainties.join()).toContain(
      "No supported backend route",
    );
  });
});
