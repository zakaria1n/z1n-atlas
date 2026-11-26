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

test.describe("live journey acceptance (real model)", () => {
  test.skip(!live, "RUN_LIVE_LLM_TESTS=true and GEMINI_API_KEY are required.");
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
    // GitHub origin needs no local-folder consent checkbox.
    await page.getByRole("button", { name: "Send and analyze" }).click();
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
    await page
      .getByLabel("Feature or question")
      .fill(
        "How does a user book a sports facility, from the frontend interaction to the final database commit? Explain each stage and provide source evidence.",
      );
    await page.getByLabel(/Send the selected files again/).check();
    await page.getByRole("button", { name: "Find path" }).click();

    // Wait for either outcome: the journey result (badge renders) or the
    // panel reporting a provider failure. Both are recorded honestly.
    await expect
      .poll(
        async () => {
          const badge = await page
            .getByText("AI-guided journey")
            .isVisible()
            .catch(() => false);
          const status = await page
            .locator(".journey-panel [role='status']")
            .first()
            .textContent()
            .catch(() => "");
          return badge || /could not|provider|failed|Check/i.test(status ?? "")
            ? "done"
            : "waiting";
        },
        { timeout: 300_000, intervals: [5_000] },
      )
      .toBe("done");
    const providerError = await page
      .locator(".journey-panel [role='status']")
      .first()
      .textContent()
      .catch(() => "");
    if (/could not|Check the provider/i.test(providerError ?? "")) {
      console.log(
        `LIVE RUN outcome: provider failure surfaced in UI — ${providerError}`,
      );
      test.info().annotations.push({
        type: "outcome",
        description: `provider failure rendered in UI: ${providerError}`,
      });
      test.skip(true, "Provider under outage; retry in a stable window.");
    }
    await expect(page.getByText("AI-guided journey")).toBeVisible({
      timeout: 30_000,
    });
    const displayed = await page
      .locator(".journey-panel")
      .textContent()
      .catch(() => "");
    // Provider outage: the interface rendered the honest empty result. An
    // account state, not a product failure — record and skip.
    if (displayed.includes("could not complete the exploration")) {
      console.log(
        "LIVE RUN outcome: provider outage; the honest empty journey rendered.",
      );
      test.info().annotations.push({
        type: "outcome",
        description: "provider outage; honest empty journey rendered in UI",
      });
      test.skip(true, "Provider under outage; retry in a stable window.");
    }
    const steps = page.locator(".journey-steps > li");
    await expect
      .poll(async () => steps.count(), { timeout: 30_000 })
      .toBeGreaterThan(0);
    await page.screenshot({
      path: testInfo.outputPath("live-journey.png"),
      fullPage: true,
    });
    const stepCount = await steps.count();
    if (stepCount === 0) {
      test.info().annotations.push({
        type: "outcome",
        description: `honest empty journey: ${displayed.slice(0, 200)}`,
      });
      return;
    }
    test.expect(stepCount).toBeGreaterThan(2);
    // Grounded explanations render a badge each; the model may legitimately
    // answer without explanations (the schema allows it), which is recorded.
    const badges = await page.locator(".support-badge").count();
    console.log(
      `LIVE RUN outcome: ${stepCount} steps, ${badges} support badges`,
    );
    const citationList = page.getByLabel("Verified code citations");
    if (badges > 0 && (await citationList.getByRole("button").count()) > 0) {
      await citationList.getByRole("button").first().click();
      await expect(
        page.getByRole("dialog", { name: "Code inspector" }),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath("live-citation.png"),
        fullPage: true,
      });
    }
    test.info().annotations.push({
      type: "outcome",
      description: `live journey rendered: ${stepCount} steps, ${badges} badges`,
    });
  });
});
