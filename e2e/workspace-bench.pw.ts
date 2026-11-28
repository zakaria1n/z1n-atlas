import { readFile } from "node:fs/promises";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";

/**
 * Production workspace renderer benchmark — drives the REAL workspace graph
 * (Sigma renderer, deterministic adapter, bounded FA2 worker) with the pinned
 * recorded snapshots, on the desktop and mobile emulation projects. These are
 * integrated workspace results, not standalone harness numbers; the mobile
 * project is Chromium mobile emulation, not a physical device.
 */
test.setTimeout(240_000);

const SNAPSHOTS = ["omnisport", "z1n-atlas", "dub-scale"] as const;
const REPO_ROOT = path.resolve(__dirname, "..");
const VIEWPORTS: Record<string, { width: number; height: number }> = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 },
};

async function seedWorkspace(page: Page, snapshot: string) {
  const raw = await readFile(
    path.join(REPO_ROOT, "apps/web/bench/sigma/graphs", `${snapshot}.json`),
    "utf8",
  );
  await page.addInitScript(
    ([graph, session]) => {
      sessionStorage.setItem("z1n_bench_graph", graph as string);
      sessionStorage.setItem("z1n_bench_session", session as string);
    },
    [
      raw,
      JSON.stringify({
        label: snapshot,
        origin: "local",
        files: [],
        skipped: 0,
        truncated: false,
      }),
    ],
  );
}

for (const snapshot of SNAPSHOTS) {
  test(`workspace sigma: ${snapshot}`, async ({ page }, testInfo) => {
    const viewport = VIEWPORTS[testInfo.project.name] ?? VIEWPORTS.desktop!;
    await page.setViewportSize(viewport);
    await seedWorkspace(page, snapshot);
    await page.goto(`/workspace?bench=1`);
    await expect(
      page.getByRole("region", { name: "Source relationship graph" }),
    ).toBeVisible();
    const stage = page.locator('[data-renderer="sigma"]');
    await expect(stage).toBeVisible();
    await expect(stage.locator("canvas").first()).toBeVisible();
    type BenchWindow = { __z1nGraphMetrics?: Record<string, unknown> };
    await expect
      .poll(
        async () =>
          page.evaluate(() =>
            Boolean((window as unknown as BenchWindow).__z1nGraphMetrics),
          ),
        { timeout: 200_000, intervals: [2_000] },
      )
      .toBe(true);
    const graph = await page.evaluate(
      () =>
        ((window as unknown as BenchWindow).__z1nGraphMetrics ?? {}) as Record<
          string,
          unknown
        >,
    );
    const metrics = await page.evaluate(() => {
      const sigma = document.querySelector('[data-renderer="sigma"]');
      const stageElement = sigma as HTMLElement | null;
      const heap = (
        performance as unknown as { memory?: { usedJSHeapSize: number } }
      ).memory;
      return {
        canvases: sigma ? sigma.querySelectorAll("canvas").length : 0,
        width: stageElement?.clientWidth ?? 0,
        heapMb: heap ? Math.round(heap.usedJSHeapSize / 1048576) : null,
      };
    });
    // Filtering latency: switch the relationship-type filter and time the
    // refresh cycle from the browser.
    const filterMs = await page.evaluate(async () => {
      const started = performance.now();
      const select = document.getElementById(
        "edge-filter",
      ) as HTMLSelectElement | null;
      if (select) {
        const option = select.options[1] as HTMLOptionElement | null;
        if (option) {
          select.value = option.value;
          select.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
      await new Promise((resolve) =>
        requestAnimationFrame(() => resolve(null)),
      );
      await new Promise((resolve) =>
        requestAnimationFrame(() => resolve(null)),
      );
      return Math.round(performance.now() - started);
    });
    console.log(
      `WORKSPACE ${snapshot}/${testInfo.project.name}: ` +
        JSON.stringify({ ...graph, filterMs, ...metrics }),
    );
    expect(graph.renderer).toBe("sigma");
    expect(graph.ttfrMs).toBeGreaterThan(0);
    test.info().annotations.push({
      type: "outcome",
      description: `ttfr:${graph.ttfrMs}ms nodes:${graph.nodes} edges:${graph.edges} filter:${filterMs}ms heap:${metrics.heapMb}MB canvases:${metrics.canvases}`,
    });
  });
}
