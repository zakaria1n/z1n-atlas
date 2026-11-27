import { expect, test } from "@playwright/test";

/**
 * React Flow renderer benchmark — measures the existing workspace graph
 * (production React Flow renderer) on the same OmniSport snapshot the
 * Sigma harness uses, with equivalent instrumentation.
 */
test.setTimeout(420_000);

// Desktop-only: the mobile workspace renders the graph behind a tab
// switch; the Sigma harness already covers the mobile viewport directly.
test.skip(
  test.info().project.name !== "desktop",
  "React Flow mobile rendering is covered by the mobile workspace e2e.",
);
test("react flow: omnisport (desktop)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/import");
  await page
    .getByLabel("GitHub repository URL")
    .fill("https://github.com/yass91-cmd/omnisport-digitale");
  await page.getByRole("button", { name: "Import repository" }).click();
  const result = page.getByRole("status").filter({
    hasText: /Repository read|Import|selected/,
  });
  await expect(result).toBeVisible({ timeout: 180_000 });
  await result.getByRole("link", { name: "Browse imported files" }).click();
  await page.getByRole("button", { name: "Analyze project" }).click();
  // TTFR: from clicking "Send and analyze" to the graph region rendering
  // at least one visible React Flow node element.
  const t0 = Date.now();
  await page.getByRole("button", { name: "Send and analyze" }).click();
  await expect(
    page.getByRole("region", { name: "Source relationship graph" }),
  ).toBeVisible({ timeout: 180_000 });
  await expect
    .poll(
      async () => {
        const nodes = await page
          .getByRole("region", { name: "Source relationship graph" })
          .locator("[data-id]")
          .count()
          .catch(() => 0);
        return nodes > 0 ? "rendered" : "waiting";
      },
      { timeout: 120_000, intervals: [500] },
    )
    .toBe("rendered");
  const ttfrMs = Date.now() - t0;

  // Pan/zoom: wheel events over the graph pane for ~2s while counting rAF.
  const region = page.getByRole("region", {
    name: "Source relationship graph",
  });
  await region.locator("[data-id]").first().waitFor({ timeout: 30_000 });
  let frames = 0;
  const count = () => {
    frames += 1;
    if (frames < 4000) requestAnimationFrame(count);
  };
  await page.evaluate(() => {
    const counter = { frames: 0, running: true };
    const step = () => {
      if (!counter.running) return;
      counter.frames += 1;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    (window as unknown as { __rfCounter: typeof counter }).__rfCounter =
      counter;
  });
  for (let step = 0; step < 20; step++) {
    await region.dispatchEvent("wheel", {
      deltaY: step % 2 ? 240 : -240,
      clientX: 400,
      clientY: 300,
    });
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(800);
  const fps = await page.evaluate(
    () =>
      (
        (
          window as unknown as {
            __rfCounter?: { frames: number; running: boolean };
          }
        ).__rfCounter ?? { frames: 0, running: true }
      ).frames / 2,
  );
  void count;

  const memoryMb = await page.evaluate(() =>
    performance.memory
      ? Math.round(
          (performance as unknown as { memory: { usedJSHeapSize: number } })
            .memory.usedJSHeapSize / 1048576,
        )
      : null,
  );

  // Filtering performance: the workspace node-kind filter, if rendered.
  const nodeCount = await region.locator("[data-id]").count();
  const tFilter = Date.now();
  const filterControl = page
    .getByRole("region", { name: "Source relationship graph" })
    .getByRole("combobox")
    .first();
  if (await filterControl.isVisible().catch(() => false)) {
    await filterControl.selectOption({ index: 1 }).catch(() => {});
    await page.waitForTimeout(400);
  }
  const filterMs = Date.now() - tFilter;

  console.log(
    `REACTFLOW omnisport/desktop: ttfr:${ttfrMs}ms fps:${Math.round(fps)} filter:${filterMs}ms heap:${memoryMb}MB visibleNodes:${nodeCount}`,
  );
  test.info().annotations.push({
    type: "outcome",
    description: `ttfr:${ttfrMs}ms fps:${Math.round(fps)} filter:${filterMs}ms heap:${memoryMb}MB nodes:${nodeCount}`,
  });
  expect(ttfrMs).toBeGreaterThan(0);
  expect(fps).toBeGreaterThan(0);
});
