import { test, expect } from "@playwright/test";

/**
 * Sigma.js renderer benchmark harness — measures the standalone Sigma
 * renderer on real snapshots. React Flow measurements are taken from the
 * real workspace renderer by the accompanying benchmark run.
 */
test.setTimeout(240_000);

const SNAPSHOTS = ["omnisport", "z1n-atlas", "dub-scale"];

for (const viewport of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
]) {
  for (const snapshot of SNAPSHOTS) {
    test(`sigma: ${snapshot} (${viewport.name})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`/sigma-bench?graph=${snapshot}`);
      type BenchWindow = {
        __benchDone?: boolean;
        __bench?: Record<string, number | string | null | boolean>;
      };
      await expect
        .poll(
          async () =>
            page.evaluate(() =>
              Boolean((window as unknown as BenchWindow).__benchDone),
            ),
          { timeout: 200_000, intervals: [2_000] },
        )
        .toBe(true);
      const bench = await page.evaluate(
        () =>
          ((window as unknown as BenchWindow).__bench ?? {}) as Record<
            string,
            unknown
          >,
      );
      console.log(
        `SIGMA ${snapshot}/${viewport.name}: ` + JSON.stringify(bench),
      );
      expect(bench.webgl).toBe(true);
      expect(bench.ttfpMs).toBeGreaterThan(0);
      test.info().annotations.push({
        type: "outcome",
        description: `ttfp:${bench.ttfpMs}ms seed:${bench.seedLayoutMs}ms worker:${bench.workerFirstTickMs}ms done:${bench.workerTerminated} select:${bench.selectLatencyMs}ms filter:${bench.filterMs}ms fps:${bench.eventsPerSecond} heap:${bench.memoryMb}MB nodes:${bench.nodes} edges:${bench.edges}`,
      });
    });
  }
}
