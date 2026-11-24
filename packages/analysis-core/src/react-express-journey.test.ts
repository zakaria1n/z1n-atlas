import { describe, expect, it } from "vitest";
import { graphIsValid } from "@z1n/contracts";
import { analyzeFiles } from "./analyze-files";

const files = [
  {
    path: "ui/App.tsx",
    content: `import React from 'react'; import {createUser} from './client'; export function App(){ const handleRegister = () => createUser(); return <form onSubmit={handleRegister}/>; }`,
  },
  {
    path: "ui/client.ts",
    content: `export function createUser(){ return fetch('/api/auth/register',{method:'POST'}); }`,
  },
  {
    path: "api/app.ts",
    content: `import express from 'express'; import {apiRouter} from './modules'; const app = express(); app.use('/api',apiRouter);`,
  },
  {
    path: "api/modules/index.ts",
    content: `import {Router} from 'express'; import {authRoutes} from './auth/routes'; const apiRouter = Router(); apiRouter.use('/auth',authRoutes); export {apiRouter};`,
  },
  {
    path: "api/modules/auth/routes.ts",
    content: `import {Router} from 'express'; import {authController} from './controller'; const router=Router(); router.post('/register', authController.register); export const authRoutes=router;`,
  },
  {
    path: "api/modules/auth/controller.ts",
    content: `import {service} from './service'; class AuthController { register = () => service.register(); } export const authController = new AuthController();`,
  },
  {
    path: "api/modules/auth/service.ts",
    content: `import {repository} from './repository'; export const service = { register(){ return repository.createUser(); } };`,
  },
  {
    path: "api/modules/auth/repository.ts",
    content: `import {db} from './db'; export const repository = { createUser(){ return db.user.create({data:{name:'A'}}); } };`,
  },
  {
    path: "api/modules/auth/db.ts",
    content: `import {PrismaClient} from '@prisma/client'; export const db = new PrismaClient();`,
  },
];
describe("React and nested Express evidence", () => {
  it("links registered event handlers, mounted routes and class-property handlers to actual source", () => {
    const graph = analyzeFiles(files);
    expect(graphIsValid(graph, files)).toBe(true);
    const node = (name: string, path?: string) =>
      graph.nodes.find(
        (item) => item.name === name && (!path || item.path === path),
      )!;
    const next = (id: string, kind: string) =>
      graph.edges.find((edge) => edge.source === id && edge.kind === kind)!;
    const component = node("App");
    const event = next(component.id, "handles-event");
    expect(graph.nodes.find((item) => item.id === event.target)?.name).toBe(
      "handleRegister",
    );
    expect(
      graph.evidence.find((item) => item.id === event.evidenceId)?.snippet,
    ).toBe("onSubmit={handleRegister}");
    const client = next(event.target, "calls");
    const request = next(client.target, "requests");
    const match = next(request.target, "http-route");
    expect(match.confidence).toBe("heuristic");
    expect(match.supportingEvidenceIds).toHaveLength(3);
    const route = graph.nodes.find((item) => item.id === match.target)!;
    expect(route.name).toBe("POST /api/auth/register");
    const handler = next(route.id, "handles");
    expect(
      graph.nodes.find((item) => item.id === handler.target),
    ).toMatchObject({
      name: "register",
      kind: "method",
      path: "api/modules/auth/controller.ts",
    });
    const service = next(handler.target, "calls");
    expect(graph.nodes.find((item) => item.id === service.target)?.name).toBe(
      "register",
    );
    const repo = next(service.target, "calls");
    expect(graph.nodes.find((item) => item.id === repo.target)?.name).toBe(
      "createUser",
    );
    expect(next(repo.target, "database-access")).toBeDefined();
  });
  it("does not invent an event link for an unresolved or dynamic handler", () => {
    const changed = files.map((file) =>
      file.path === "ui/App.tsx"
        ? {
            ...file,
            content: `import React from 'react'; export function App(){ return <form onSubmit={missing}/>; }`,
          }
        : file,
    );
    const graph = analyzeFiles(changed);
    expect(graphIsValid(graph, changed)).toBe(true);
    expect(graph.edges.filter((edge) => edge.kind === "handles-event")).toEqual(
      [],
    );
  });
  it("recognizes automatic JSX only with a supported project manifest", () => {
    const source = {
      path: "ui/App.tsx",
      content: `export function App(){ const handle = () => 1; return <button onClick={handle}/>; }`,
    };
    const absent = analyzeFiles([source]);
    expect(
      absent.edges.filter((edge) => edge.kind === "handles-event"),
    ).toHaveLength(0);
    const withManifest = [
      source,
      { path: "ui/package.json", content: '{"dependencies":{"react":"18"}}' },
    ];
    const graph = analyzeFiles(withManifest);
    const edge = graph.edges.find((item) => item.kind === "handles-event");
    expect(graphIsValid(graph, withManifest)).toBe(true);
    expect(
      edge?.supportingEvidenceIds?.map(
        (id) => graph.evidence.find((item) => item.id === id)?.filePath,
      ),
    ).toEqual(["ui/package.json"]);
  });
  it("terminates router cycles without inventing paths through the cycle", () => {
    const source = [
      {
        path: "server.ts",
        content: `import express, {Router} from 'express'; const app=express(); const a=Router(); const b=Router(); app.use('/api',a); a.use('/b',b); b.use('/again',a); b.get('/health', handler); function handler() { return 'ok'; }`,
      },
    ];
    const graph = analyzeFiles(source);
    expect(graphIsValid(graph, source)).toBe(true);
    expect(
      graph.nodes
        .filter((node) => node.kind === "route")
        .map((node) => node.name),
    ).toEqual(["GET /api/b/health"]);
    expect(graph.unresolved).toBeGreaterThan(0);
  });
});
