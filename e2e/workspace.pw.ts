import { expect, test } from "@playwright/test";
const files: Record<string, string> = {
  "ui.tsx":
    "import {createUser} from './client'; export function Form(){ return createUser(); }",
  "client.ts":
    "export function createUser(){ return fetch('/api/users',{method:'POST'}); }",
  "server.ts":
    "import express from 'express'; import {router} from './routes'; const app=express(); app.use('/api',router);",
  "routes.ts":
    "import {Router} from 'express'; import {create} from './controller'; export const router=Router(); router.post('/users',create);",
  "controller.ts":
    "import {save} from './service'; export function create(){ return save(); }",
  "service.ts":
    "import {insert} from './repo'; export function save(){ return insert(); }",
  "repo.ts":
    "import {db} from './db'; export function insert(){return db.user.create({data:{name:'A'}});}",
  "db.ts":
    "import {PrismaClient} from '@prisma/client'; export const db = new PrismaClient();",
};
test("imports local source, analyzes a real graph, follows a journey and opens a chat citation", async ({
  page,
}, testInfo) => {
  await page.addInitScript((fixture) => {
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: async () => ({
        kind: "directory",
        name: "fixture",
        async *values() {
          yield {
            kind: "directory",
            name: "src",
            async *values() {
              for (const [name, content] of Object.entries(fixture))
                yield {
                  kind: "file",
                  name,
                  getFile: async () => new File([content], name),
                };
            },
          };
        },
      }),
    });
  }, files);
  const cors = {
    "access-control-allow-origin": "http://localhost:3000",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
  await page.route("**/api/providers/models", (route) =>
    route.fulfill({
      status: 200,
      headers: cors,
      json: {
        models: [{ id: "demo", label: "Demo", compatibility: "candidate" }],
        partial: false,
        notice: "Mock provider",
      },
    }),
  );
  await page.route("**/api/chat", (route) =>
    route.fulfill({
      status: 200,
      headers: cors,
      json: {
        claims: [
          {
            text: "The form calls createUser.",
            citations: [
              {
                id: "fixture",
                filePath: "src/ui.tsx",
                startLine: 1,
                endLine: 1,
                snippet: "return createUser();",
              },
            ],
          },
        ],
        uncertainties: [],
      },
    }),
  );
  // The AI-guided journey is answered by a mock that only uses identifiers
  // of the real analyzed graph; static requests go to the real backend.
  const analysisGraph: {
    nodes: { id: string; name?: string }[];
    edges: { id: string; source: string; target: string; kind: string }[];
  };
  await page.route("**/api/journeys", async (route) => {
    const payload = route.request().postDataJSON() as {
      ai?: unknown;
      analysisId?: string;
    };
    if (!payload.ai) return route.continue();
    const form = analysisGraph.nodes.find((node) => node.name === "Form")!;
    const link = analysisGraph.edges.find(
      (edge) => edge.source === form.id && edge.kind === "calls",
    )!;
    const callee = analysisGraph.nodes.find((node) => node.id === link.target)!;
    return route.fulfill({
      status: 200,
      headers: cors,
      json: {
        mode: "ai",
        nodeIds: [form.id, callee.id],
        edgeIds: [link.id],
        uncertainties: [
          "Mocked answer: a selected path is never a verified runtime trace.",
        ],
        explanations: [
          { nodeId: form.id, text: "The form the user submits." },
          { nodeId: callee.id, text: "Sends the request." },
        ],
      },
    });
  });
  await page.goto("/settings");
  await page.getByLabel("API key").fill("synthetic-key");
  await page.getByRole("button", { name: "Retrieve models" }).click();
  await page.getByLabel("Model", { exact: true }).selectOption("demo");
  await page.getByRole("link", { name: "Explore", exact: true }).click();
  await page.getByRole("button", { name: "Choose local folder" }).click();
  await page.getByRole("link", { name: "Browse imported files" }).click();
  await page.getByRole("button", { name: "Analyze project" }).click();
  await page
    .getByLabel(
      "I agree to send these local files to this backend for analysis.",
    )
    .check();
  const analysisResponse = page.waitForResponse(
    async (response) =>
      response.url().includes("/api/analysis/jobs/") &&
      response.request().method() === "GET" &&
      response.ok() &&
      (await response.json()).status === "complete",
  );
  await page.getByRole("button", { name: "Send and analyze" }).click();
  const analysisJson = await (await analysisResponse).json();
  const analysisId = analysisJson.graph.analysisId as string;
  analysisGraph = analysisJson.graph;
  expect(analysisId).toBeTruthy();
  await expect(
    page.getByRole("region", { name: "Source relationship graph" }),
  ).toBeVisible();
  await expect(page.getByLabel("Graph scope")).toHaveValue("files");
  await page.getByText("Feature Journey", { exact: true }).click();
  // A configured provider makes AI-guided the default exploration mode.
  await expect(page.getByLabel("AI-guided.")).toBeChecked();
  await expect(page.getByLabel("Static path.")).toBeVisible();
  await page.getByLabel("Feature or question").fill("user registration");
  await page.getByLabel(/Send the selected files again/).check();
  const journeyRequest = page.waitForRequest(
    (request) =>
      request.url().endsWith("/api/journeys") && request.method() === "POST",
  );
  await page.getByRole("button", { name: "Find path" }).click();
  const journeyPayload = (await journeyRequest).postDataJSON();
  expect(journeyPayload.analysisId).toBe(analysisId);
  expect(journeyPayload.ai.model).toBe("demo");
  await expect(page.getByLabel("Graph scope")).toHaveValue("journey");
  await expect(page.getByText("AI-guided journey")).toBeVisible();
  await expect(page.getByText("The form the user submits.")).toBeVisible();
  await expect(page.locator(".journey-steps > li")).toHaveCount(2);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  // The static mode passes through to the real backend, is explicitly
  // labeled deterministic, and sends no provider data.
  await page.getByLabel("Static path.").check();
  const staticRequest = page.waitForRequest(
    (request) =>
      request.url().endsWith("/api/journeys") && request.method() === "POST",
  );
  await page.getByRole("button", { name: "Find path" }).click();
  {
    const payload = (await staticRequest).postDataJSON();
    expect(payload.ai).toBeUndefined();
    expect(payload.analysisId).toBe(analysisId);
  }
  await expect(page.locator(".journey-steps > li")).toHaveCount(8);
  await expect(page.locator(".react-flow__node")).toHaveCount(8);
  await expect(page.locator(".react-flow__edge")).toHaveCount(7);
  await expect(
    page.getByText("deterministic name ranking, not AI understanding"),
  ).toBeVisible();
  await expect(
    page.getByText("The request and route are a possible match."),
  ).toBeVisible();
  if (testInfo.project.name === "desktop") {
    await page.addStyleTag({ content: "nextjs-portal { display: none; }" });
    await page.screenshot({ path: testInfo.outputPath("journey.png") });
  }
  await page.getByRole("button", { name: "src/controller.ts:1" }).click();
  await expect(
    page.getByRole("dialog", { name: "Code inspector" }),
  ).toContainText("src/controller.ts");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Open AI assistant" }).click();
  await page.getByLabel("Your question").fill("Where is the form?");
  await page.getByLabel(/I agree to send the selected files/).check();
  const chatRequest = page.waitForRequest(
    (request) =>
      request.url().endsWith("/api/chat") && request.method() === "POST",
  );
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  expect((await chatRequest).postDataJSON().analysisId).toBe(analysisId);
  await expect(page.getByText("The form calls createUser.")).toBeVisible();
  await page
    .getByRole("dialog", { name: "AI assistant" })
    .getByRole("button", { name: "src/ui.tsx:1" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Code inspector" }),
  ).toContainText("src/ui.tsx");
  await page.keyboard.press("Escape");
});
