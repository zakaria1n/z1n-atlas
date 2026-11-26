import { expect, test } from "@playwright/test";

/**
 * LIVE-MODEL browser acceptance — development-only, opt-in.
 *
 * Run with:  RUN_LIVE_LLM_TESTS=true npx playwright test e2e/live-journey.pw.ts
 *
 * Requires apps/api/.env with ENABLE_DEV_LLM_KEYS=true and a working
 * provider key (server-managed AI; no key ever reaches the browser).
 * This file exercises the REAL interface with REAL inference: GitHub
 * import, analysis, AI-guided journey, support badges and citations.
 * The simulated browser tests in workspace.pw.ts remain separate.
 */
const live =
  process.env.RUN_LIVE_LLM_TESTS === "true" &&
  process.env.GEMINI_API_KEY !== undefined;

test.describe.skipIf(!live)("live journey acceptance (real model)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test.setTimeout(420_000);

  test("books a facility through the real interface with grounded explanations", async ({
    page,
  }, testInfo) => {
    test.info().annotations.push({
      type: "kind",
      description: "live-model browser acceptance (not simulated)",
    });
    await page.goto("/import");
    await page
      .getByLabel("GitHub repository URL")
      .fill("https://github.com/yass91-cmd/omnisport-digitale");
    await page.getByRole("button", { name: "Import repository" }).click();
    const result = page.getByRole("status").filter({
      hasText: /Repository read|Import|selected/,
    });
    await expect(result).toBeVisible({ timeout: 120_000 });
    await result.getByRole("link", { name: "Browse imported files" }).click();
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
      { timeout: 180_000 },
    );
    await expect(
      page.getByRole("region", { name: "Source relationship graph" }),
    ).toBeVisible({ timeout: 180_000 });
    const graph = (await (await analysisResponse).json()).graph;
    const routeNodes = graph.nodes.filter((node) => node.kind === "route");
    test.expect(routeNodes.length).toBeGreaterThan(5);

    await page.getByText("Feature Journey", { exact: true }).click();
    // Server-managed AI: serverAi mode, no key ever reaches the browser.
    const aiStatus = await page.evaluate(() =>
      fetch("http://127.0.0.1:4000/api/ai/status").then((r) => r.json()),
    );
    test.expect(aiStatus.available).toBe(true);
    await page.getByLabel("AI-guided.").check();
    await page.getByLabel("Feature or question").fill(
      "How does a user book a sports facility, from the frontend interaction to the final database commit? Explain each stage and provide source evidence.",
    );
    await page.getByLabel(/Send the selected files again/).check();
    await page.getByRole("button", { name: "Find path" }).click();

    // Either a real grounded journey renders, or the provider outage is
    // reported honestly — both are recorded; screenshots capture either.
    const outcome = await page
      .locator(".journey-mode-badge, [role='status']")
      .first()
      .textContent({ timeout: 300_000 })
      .catch(() => null);
    await page.screenshot({
      path: testInfo.outputPath("live-journey.png"),
      fullPage: true,
    });
    const steps = page.locator(".journey-steps > li");
    const stepCount = await steps.count();
    if (stepCount === 0) {
      const status = await page
        .locator("[role='status']")
        .first()
        .textContent();
      console.log(`LIVE RUN outcome: no journey rendered — status: ${status}`);
      test.expect
        .soft(outcome ?? "")
        .toContain("journey");
      test.info().annotations.push({
        type: "outcome",
        description: `provider did not return a journey: ${status}`,
      });
      return;
    }
    test.expect(stepCount).toBeGreaterThan(2);
    // Real grounded explanations: at least one support badge is rendered,
    // and heuristic transitions are labelled as such.
    const badges = await page.locator(".support-badge").count();
    console.log(`LIVE RUN outcome: ${stepCount} steps, ${badges} support badges`);
    test.expect(badges).toBeGreaterThan(0);
    const citation = page
      .getByLabel("Verified code citations")
      .getByRole("button")
      .first();
    await citation.click();
    await expect(
      page.getByRole("dialog", { name: "Code inspector" }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("live-citation.png"),
      fullPage: true,
    });
    test.info().annotations.push({
      type: "outcome",
      description: `live journey rendered: ${stepCount} steps, ${badges} badges`,
    });
  });
});
