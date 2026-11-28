import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

/**
 * React Flow fallback benchmark — measures the WebGL-fallback renderer (the
 * bounded React Flow subset) on the same pinned OmniSport snapshot the Sigma
 * workspace benchmark uses, with equivalent instrumentation. Sigma.js is the
 * production renderer for the repository-wide scopes; this is the disclosed
 * no-WebGL path, kept measurable so fallback regressions are visible.
 *
 * Desktop-only: the fallback's DOM grid is identical across viewports and
 * the mobile workspace is covered by the Sigma benchmark.
 */
test.setTimeout(240_000);
test("react flow fallback: omnisport (desktop)", async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "The fallback grid is viewport-independent; the Sigma benchmark covers mobile.",
  );
  const raw = await readFile(
    path.join(__dirname, "../apps/web/bench/sigma/graphs/omnisport.json"),
    "utf8",
  );
  // Force the no-WebGL path and seed the recorded snapshot into the real
  // workspace (dev-only benchmark bootstrap).
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
  await page.addInitScript(
    ([graph, session]) => {
      sessionStorage.setItem("z1n_bench_graph", graph as string);
      sessionStorage.setItem("z1n_bench_session", session as string);
    },
    [
      raw,
      JSON.stringify({
        label: "omnisport",
        origin: "local",
        files: [],
        skipped: 0,
        truncated: false,
      }),
    ],
  );
  const t0 = Date.now();
  await page.goto("/workspace");
  const region = page.getByRole("region", {
    name: "Source relationship graph",
  });
  await expect(region).toBeVisible({ timeout: 120_000 });
  await expect(
    page.getByText(
      /WebGL is unavailable, so the graph renders as a bounded subset/,
    ),
  ).toBeVisible();
  await expect
    .poll(
      async () => {
        const nodes = await region
          .locator("[data-id]")
          .count()
          .catch(() => 0);
        return nodes > 0 ? "rendered" : "waiting";
      },
      { timeout: 120_000, intervals: [500] },
    )
    .toBe("rendered");
  const ttfrMs = Date.now() - t0;

  // Pan/zoom: wheel events over the graph pane while counting frames.
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

  const memoryMb = await page.evaluate(() =>
    performance.memory
      ? Math.round(
          (performance as unknown as { memory: { usedJSHeapSize: number } })
            .memory.usedJSHeapSize / 1048576,
        )
      : null,
  );

  const nodeCount = await region.locator("[data-id]").count();
  const tFilter = Date.now();
  const filterControl = region.getByRole("combobox").last();
  if (await filterControl.isVisible().catch(() => false)) {
    await filterControl.selectOption({ index: 1 }).catch(() => {});
    await page.waitForTimeout(400);
  }
  const filterMs = Date.now() - tFilter;

  console.log(
    `REACTFLOW-FALLBACK omnisport/desktop: ttfr:${ttfrMs}ms fps:${Math.round(fps)} filter:${filterMs}ms heap:${memoryMb}MB renderedNodes:${nodeCount}`,
  );
  test.info().annotations.push({
    type: "outcome",
    description: `ttfr:${ttfrMs}ms fps:${Math.round(fps)} filter:${filterMs}ms heap:${memoryMb}MB nodes:${nodeCount}`,
  });
  expect(ttfrMs).toBeGreaterThan(0);
  expect(fps).toBeGreaterThan(0);
});
