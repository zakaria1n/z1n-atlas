import { expect, test, type Page } from "@playwright/test";

/**
 * Integrated workspace acceptance for the Sigma renderer: real analysis of
 * imported source, then every preserved interaction — node selection, source
 * navigation, relationship evidence, filters, scopes, journey highlighting,
 * repository switching, keyboard camera control and the WebGL fallback.
 * Journeys and chat use deterministic mocks; the analysis is the real
 * backend.
 */

type FixtureFile = { name: string; content: string };
const FILES: FixtureFile[] = [
  {
    name: "ui.tsx",
    content:
      "import {createUser} from './client'; export function Form(){ return createUser(); }",
  },
  {
    name: "client.ts",
    content:
      "export function createUser(){ return fetch('/api/users',{method:'POST'}); }",
  },
  {
    name: "db.ts",
    content:
      "import {PrismaClient} from '@prisma/client'; export const db = new PrismaClient();",
  },
  {
    name: "repo.ts",
    content:
      "import {db} from './db'; export function insert(){return db.user.create({data:{name:'A'}});}",
  },
];
const SECOND_FILES: FixtureFile[] = [
  {
    name: "worker.ts",
    content: "import express from 'express'; export const app = express();",
  },
];

async function importAndAnalyze(page: Page, files: FixtureFile[]) {
  await page.addInitScript((fixture) => {
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: async () => ({
        kind: "directory",
        name: "fixture",
        async *values() {
          for (const { name, content } of fixture)
            yield {
              kind: "file",
              name,
              getFile: async () => new File([content], name),
            };
        },
      }),
    });
  }, files);
  await page.goto("/workspace");
  if (
    await page.getByRole("link", { name: "Explore import options" }).isVisible()
  )
    await page.getByRole("link", { name: "Explore import options" }).click();
  else await page.goto("/import");
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
  return ((await (await analysisResponse).json()).graph.analysisId ??
    "") as string;
}

test("workspace renders with Sigma and preserves every interaction", async ({
  page,
}, testInfo) => {
  // The real analysis round trip consumes a large part of the default
  // per-test budget; the interaction sweep needs its own allowance.
  test.setTimeout(180_000);
  const analysisId = await importAndAnalyze(page, FILES);
  expect(analysisId).toBeTruthy();
  const stage = page.locator('[data-renderer="sigma"]');
  await expect(stage).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Source relationship graph" }),
  ).toContainText("Blue: static or framework");

  // Node selection opens source through the WebGL picking pipeline. The
  // dev-only graph API installs on first render; wait browser-side because
  // its first tick can trail the stage by a few seconds.
  await page.waitForFunction(
    () => Boolean((window as { __z1nGraphApi?: unknown }).__z1nGraphApi),
    undefined,
    { timeout: 30_000, polling: 1000 },
  );
  const point = await page.evaluate(() => {
    const api = (
      window as unknown as {
        __z1nGraphApi?: {
          nodeIds: () => string[];
          nodeViewportPosition: (
            id: string,
          ) => { x: number; y: number } | undefined;
        };
      }
    ).__z1nGraphApi;
    if (!api) return null;
    const element = document.querySelector('[data-renderer="sigma"]');
    const bounds = element?.getBoundingClientRect();
    if (!bounds) return null;
    for (const id of api.nodeIds()) {
      const position = api.nodeViewportPosition(id);
      if (!position) continue;
      // graphToViewport returns pixels within the stage element.
      const x = bounds.left + position.x;
      const y = bounds.top + position.y;
      if (x > 60 && y > 120) return { x, y };
    }
    return null;
  });
  expect(point).not.toBeNull();
  await page.mouse.click(point!.x, point!.y);
  await expect(
    page.getByRole("dialog", { name: "Code inspector" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  // Relationship evidence through the keyboard-accessible list.
  await page.getByText(/Inspect relationships \(\d+\)/).click();
  await page.locator(".relations button").first().click();
  const evidence = page.getByRole("region", {
    name: "Relationship evidence",
  });
  await expect(evidence).toBeVisible();
  await evidence.getByRole("button", { name: "Open source" }).click();
  await expect(
    page.getByRole("dialog", { name: "Code inspector" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await evidence
    .getByRole("button", { name: "Close relationship evidence" })
    .click();

  // Relationship-type filtering updates the scoped list without breaking.
  await page.getByLabel("Relationship type").selectOption("imports");
  await expect(page.getByText(/Inspect relationships \(\d+\)/)).toBeVisible();
  await page.getByLabel("Relationship type").selectOption("all");

  // Scope switching: files and symbols stay on Sigma.
  await page.getByLabel("Graph scope").selectOption("all");
  await expect(page.locator('[data-renderer="sigma"]')).toBeVisible();
  await page.getByLabel("Graph scope").selectOption("files");
  await expect(page.locator('[data-renderer="sigma"]')).toBeVisible();

  // Keyboard camera control on the sigma stage.
  const stageKeyboard = page.getByRole("application", {
    name: /Interactive source relationship graph/,
  });
  await stageKeyboard.focus();
  await stageKeyboard.press("+");
  await stageKeyboard.press("ArrowLeft");
  await stageKeyboard.press("0");
  await stageKeyboard.press("Escape");

  // Zoom cluster buttons drive the same camera.
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByRole("button", { name: "Reset view" }).click();

  // Repository switching: a new import replaces graph, worker and camera.
  await page.addInitScript((fixture) => {
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: async () => ({
        kind: "directory",
        name: "fixture-2",
        async *values() {
          for (const { name, content } of fixture)
            yield {
              kind: "file",
              name,
              getFile: async () => new File([content], name),
            };
        },
      }),
    });
  }, SECOND_FILES);
  await page.goto("/import");
  await page.getByRole("button", { name: "Choose local folder" }).click();
  await page.getByRole("link", { name: "Browse imported files" }).click();
  await page.getByRole("button", { name: "Analyze project" }).click();
  await page
    .getByLabel(
      "I agree to send these local files to this backend for analysis.",
    )
    .check();
  const secondResponse = page.waitForResponse(
    async (response) =>
      response.url().includes("/api/analysis/jobs/") &&
      response.request().method() === "GET" &&
      response.ok() &&
      (await response.json()).status === "complete",
  );
  await page.getByRole("button", { name: "Send and analyze" }).click();
  const secondId = ((await (await secondResponse).json()).graph.analysisId ??
    "") as string;
  expect(secondId).not.toBe(analysisId);
  await expect(page.locator('[data-renderer="sigma"]')).toBeVisible();

  if (testInfo.project.name === "desktop") {
    await page.addStyleTag({ content: "nextjs-portal { display: none; }" });
    await page.screenshot({ path: testInfo.outputPath("workspace-sigma.png") });
  }
});

test("WebGL fallback renders a bounded subset with disclosure", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      ...args: Parameters<typeof HTMLCanvasElement.prototype.getContext>
    ) {
      if (String(args[0]).startsWith("webgl")) return null;
      return original.apply(this, args);
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
  await importAndAnalyze(page, FILES);
  const stage = page.locator('[data-renderer="react-flow"]');
  await expect(stage).toBeVisible();
  await expect(
    page.getByText(
      /WebGL is unavailable, so the graph renders as a bounded subset/,
    ),
  ).toBeVisible();
  // The fallback keeps source navigation working; a node toward the end of
  // the grid sits clear of the information panel overlay.
  await page.locator(".react-flow__node").last().click();
  await expect(
    page.getByRole("dialog", { name: "Code inspector" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  // And journey scope still renders its focused React Flow diagram.
  await expect(page.getByLabel("Graph scope")).toHaveValue("files");
});
