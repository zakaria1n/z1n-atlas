import { expect, test, type Page } from "@playwright/test";

const commit = "b".repeat(40);
const repository = {
  owner: "example",
  name: "atlas-demo",
  url: "https://github.com/example/atlas-demo",
};
// The client verifies that size matches the UTF-8 byte length of content.
const source = (path: string, content: string) => ({
  path,
  content,
  size: new TextEncoder().encode(content).length,
});
const analyzed = source("src/app.ts", "export const value = 1;");
const indexedOnly = source("src/only-indexed.ts", "export {};\n//");
const cors = {
  "access-control-allow-origin": "http://localhost:3000",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};
async function mockGitHub(page: Page) {
  const state = { fileRequests: [] as unknown[] };
  page.on("request", (request) => {
    if (request.url().endsWith("/api/repositories/file"))
      state.fileRequests.push(request.postDataJSON());
  });
  await page.route("**/api/repositories/import", (route) =>
    route.fulfill({
      status: 200,
      headers: cors,
      json: {
        repository,
        commit,
        files: [analyzed],
        inventory: [
          { path: "docs/guide.md", size: 13 },
          { path: analyzed.path, size: analyzed.size },
          { path: indexedOnly.path, size: indexedOnly.size },
        ],
        indexTruncated: false,
        skipped: 1,
        truncated: false,
      },
    }),
  );
  return state;
}
function mockFile(page: Page) {
  return page.route("**/api/repositories/file", (route) => {
    const body = route.request().postDataJSON() as { path: string };
    if (body.path === indexedOnly.path)
      return route.fulfill({ status: 200, headers: cors, json: indexedOnly });
    return route.fulfill({
      status: 404,
      headers: cors,
      json: { error: "The requested file is unavailable." },
    });
  });
}

test("indexes a public repository and opens unanalyzed files on demand", async ({
  page,
}) => {
  const state = await mockGitHub(page);
  await mockFile(page);
  await page.goto("/import");
  await page.getByLabel("GitHub repository URL").fill(repository.url);
  await page.getByRole("button", { name: "Import repository" }).click();
  const result = page
    .getByRole("status")
    .filter({ hasText: "Repository read" });
  await expect(result).toContainText(
    "1 files selected for analysis · 1 files skipped",
  );
  await expect(result).toContainText("3 eligible paths indexed for inspection");
  await result.getByRole("link", { name: "Browse imported files" }).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Files" });
  await expect(drawer).toContainText(
    "3 indexed paths · 1 files in the current analysis",
  );
  // The tree starts collapsed so that large indexes stay responsive.
  await expect(
    drawer.getByRole("button", { name: indexedOnly.path }),
  ).toHaveCount(0);
  await drawer.locator("summary", { hasText: /^src$/ }).click();
  await drawer
    .getByRole("button", { name: indexedOnly.path, exact: true })
    .click();
  const inspector = page.getByRole("dialog", { name: "Code inspector" });
  await expect(inspector).toContainText(indexedOnly.path);
  await expect(inspector).toContainText("export {};");
  await expect(inspector).toContainText(
    "This file is not included in the current graph or AI context.",
  );
  expect(state.fileRequests).toEqual([
    { url: repository.url, commit, path: indexedOnly.path },
  ]);
  await page.keyboard.press("Escape");
  // A recently inspected file is reused instead of hitting the backend again.
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await drawer
    .getByRole("button", { name: indexedOnly.path, exact: true })
    .click();
  await expect(inspector).toContainText("export {};");
  await page.keyboard.press("Escape");
  expect(state.fileRequests).toHaveLength(1);
  // Files that were analyzed open without any inspection request.
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await drawer
    .getByRole("button", { name: analyzed.path, exact: true })
    .click();
  await expect(inspector).toContainText("export const value = 1;");
  await expect(
    inspector.getByText(
      "This file is not included in the current graph or AI context.",
    ),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  expect(state.fileRequests).toHaveLength(1);
  // Filtering expands only the matching paths.
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByLabel("Filter files").fill("GUIDE");
  await expect(
    drawer.getByRole("button", { name: indexedOnly.path }),
  ).toHaveCount(0);
  await drawer
    .getByRole("button", { name: "docs/guide.md", exact: true })
    .click();
  await expect(
    inspector.getByRole("alert").filter({ hasText: "unavailable" }),
  ).toBeVisible();
  expect(state.fileRequests).toHaveLength(2);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("recovers from a cancelled, rejected and invalid GitHub import", async ({
  page,
}) => {
  let release = () => {};
  await page.route("**/api/repositories/import", async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
      setTimeout(resolve, 10_000);
    });
    await route.abort().catch(() => {});
  });
  await page.goto("/import");
  const url = page.getByLabel("GitHub repository URL");
  const submit = page.getByRole("button", {
    name: /^(Import repository|Reading repository…)$/,
  });
  await url.fill("https://github.com/example/slow");
  await submit.click();
  await expect(
    page.getByRole("button", { name: "Cancel import" }),
  ).toBeVisible();
  await expect(submit).toBeDisabled();
  await page.getByRole("button", { name: "Cancel import" }).click();
  release();
  await expect(submit).toBeEnabled();
  // Scoped to the page content: the development overlay renders its own alert.
  const alerts = page.getByRole("main").getByRole("alert");
  await expect(alerts).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Browse imported files" }),
  ).toHaveCount(0);
  await page.unroute("**/api/repositories/import");
  await page.route("**/api/repositories/import", (route) =>
    route.fulfill({
      status: 429,
      headers: cors,
      json: { error: "Service is busy. Try again shortly." },
    }),
  );
  await url.fill(repository.url);
  await submit.click();
  await expect(alerts).toHaveText("Service is busy. Try again shortly.");
  await expect(submit).toBeEnabled();
  await url.fill("https://gitlab.com/example/repository");
  await submit.click();
  await expect(alerts).toContainText("Enter a public GitHub repository URL");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
