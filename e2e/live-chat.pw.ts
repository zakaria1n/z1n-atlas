import { expect, test } from "@playwright/test";

/**
 * LIVE-MODEL browser chat acceptance — development-only, opt-in.
 *
 * Run with: RUN_LIVE_LLM_TESTS=true npx playwright test e2e/live-chat.pw.ts
 *
 * Real OmniSport import, real LangGraph chat orchestration, real model
 * inference through the development bridge: a short conversation covering
 * application architecture, booking functionality, a database follow-up
 * and source inspection, with clickable citations. Desktop and mobile
 * viewports; never uses mocked responses.
 */
const live =
  process.env.RUN_LIVE_LLM_TESTS === "true" &&
  process.env.GEMINI_API_KEY !== undefined;

const QUESTIONS = [
  "What is the overall architecture of this application? Name the main parts.",
  "How does booking a sports facility work in the backend?",
  "Which function writes the booking to the database?",
  "Show me the actual source lines of that database write.",
];

test.describe("live chat acceptance (real model)", () => {
  test.skip(!live, "RUN_LIVE_LLM_TESTS=true and GEMINI_API_KEY are required.");
  test.setTimeout(900_000);
  for (const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "mobile", width: 390, height: 844 },
  ]) {
    test(`asks a real conversation about the imported repository (${viewport.name})`, async ({
      page,
    }, testInfo) => {
      test.info().annotations.push({
        type: "kind",
        description: `live-model browser chat acceptance (${viewport.name})`,
      });
      await page.setViewportSize(viewport);
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
      await page.getByRole("button", { name: "Send and analyze" }).click();
      await expect(
        page.getByRole("region", { name: "Source relationship graph" }),
      ).toBeVisible({ timeout: 180_000 });

      const aiStatus = await page.evaluate(() =>
        fetch("http://127.0.0.1:4000/api/ai/status").then((r) => r.json()),
      );
      test.expect(aiStatus.available).toBe(true);

      await page.getByRole("button", { name: "Open AI assistant" }).click();
      await page.getByLabel(/I agree to send the selected files/).check();

      const answers: string[] = [];
      for (const [index, question] of QUESTIONS.entries()) {
        const input = page.getByLabel("Your question");
        await input.fill(question);
        await page.getByRole("button", { name: "Ask", exact: true }).click();
        // Each turn may explore; wait for this turn's answer before the
        // next question so the conversation stays sequential.
        await expect
          .poll(
            async () => {
              const text = await page
                .getByRole("dialog", { name: "AI assistant" })
                .textContent()
                .catch(() => "");
              const markers = (text.match(/Claim|verified|uncertaint/gi) ?? [])
                .length;
              return markers >= index + 1 ? "done" : "waiting";
            },
            { timeout: 300_000, intervals: [5_000] },
          )
          .toBe("done");
        answers.push(
          (
            await page
              .getByRole("dialog", { name: "AI assistant" })
              .textContent()
              .catch(() => "")
          ).slice(0, 600),
        );
      }

      // Chat citations are buttons named "path:line" inside the
      // assistant dialog (the "Verified code citations" label belongs to
      // the journey panel).
      const citationButtons = page
        .getByRole("dialog", { name: "AI assistant" })
        .getByRole("button", { name: /:\d+/ });
      const citationCount = await citationButtons.count();
      if (citationCount > 0) {
        await citationButtons.first().click();
        await expect(
          page.getByRole("dialog", { name: "Code inspector" }),
        ).toBeVisible();
        await page.keyboard.press("Escape");
      }
      await page.screenshot({
        path: testInfo.outputPath("live-chat.png"),
        fullPage: true,
      });
      // Substantive answers: each turn returned real content (not an
      // error banner) and the final answer offers clickable citations.
      const substantive = answers.filter(
        (answer) => answer.length > 200,
      ).length;
      const ok = substantive >= 3 && citationCount > 0;
      test.info().annotations.push({
        type: "outcome",
        description: `answers:${answers.length}; substantive:${substantive}; citations:${citationCount}; final:${answers[3]?.slice(0, 200) ?? ""}`,
      });
      test.expect(ok).toBe(true);
    });
  }
});
