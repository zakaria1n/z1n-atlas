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
    (response) =>
      response.url().endsWith("/api/analysis") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Send and analyze" }).click();
  const analysisId = (await (await analysisResponse).json())
    .analysisId as string;
  expect(analysisId).toBeTruthy();
  await expect(
    page.getByRole("region", { name: "Source relationship graph" }),
  ).toBeVisible();
  await expect(page.getByLabel("Graph scope")).toHaveValue("files");
  await page.getByText("Feature Journey", { exact: true }).click();
  await expect(
    page.getByLabel(/Use the selected AI provider to help rank evidence/),
  ).toBeVisible();
  await page.getByLabel("Feature or symbol").fill("user registration");
  await page.getByLabel(/Send the selected files again/).check();
  const journeyRequest = page.waitForRequest(
    (request) =>
      request.url().endsWith("/api/journeys") && request.method() === "POST",
  );
  await page.getByRole("button", { name: "Find path" }).click();
  expect((await journeyRequest).postDataJSON().analysisId).toBe(analysisId);
  await expect(page.getByLabel("Graph scope")).toHaveValue("all");
  await expect(page.locator(".journey-steps > li")).toHaveCount(8);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
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
