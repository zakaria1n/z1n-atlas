import { describe, expect, it } from "vitest";
import { classifyLiveRun } from "./live-verdict";

const base = {
  badgeVisible: true,
  stepCount: 5,
  panelText: "AI-guided journey Explanations…",
  supportLevels: ["source", "partial"],
  relatedOperationLabels: [
    "SQLAlchemy write add Booking (code presence, not a runtime guarantee)",
    "SQLAlchemy commit (transaction boundary — conditional)",
  ],
};

describe("live browser verdict classification", () => {
  it("passes a grounded booking journey with persistence evidence", () => {
    const verdict = classifyLiveRun(base);
    expect(verdict.verdict).toBe("PASS");
  });

  it("fails when the provider succeeded but no path rendered", () => {
    const verdict = classifyLiveRun({
      ...base,
      stepCount: 0,
      panelText:
        "AI-guided journey No supported relationship connects these steps.",
    });
    expect(verdict.verdict).toBe("FAIL");
    expect(verdict.reason).toContain("Empty journey");
  });

  it("fails a two-step path that cannot show frontend-to-persistence", () => {
    const verdict = classifyLiveRun({ ...base, stepCount: 2 });
    expect(verdict.verdict).toBe("FAIL");
    expect(verdict.reason).toContain("too short");
  });

  it("fails when no explanation carries a support classification", () => {
    const verdict = classifyLiveRun({ ...base, supportLevels: [] });
    expect(verdict.verdict).toBe("FAIL");
    expect(verdict.reason).toContain("support classification");
  });

  it("fails when related persistence evidence is missing", () => {
    const verdict = classifyLiveRun({
      ...base,
      relatedOperationLabels: ["SQLAlchemy read get Team (read)"],
    });
    expect(verdict.verdict).toBe("FAIL");
    expect(verdict.reason).toContain("persistence write");
  });

  it("skips as external blocker only on a typed provider outage", () => {
    const verdict = classifyLiveRun({
      ...base,
      badgeVisible: false,
      panelText:
        "The AI provider could not complete the exploration. Check the provider and model in Settings.",
    });
    expect(verdict.verdict).toBe("SKIP_EXTERNAL");
    expect(verdict.reason).toContain("Provider outage");
  });

  it("skips a rendered empty journey only when the app names the provider failure", () => {
    const verdict = classifyLiveRun({
      ...base,
      stepCount: 0,
      panelText:
        "AI-guided journey The AI provider could not complete the exploration.",
    });
    expect(verdict.verdict).toBe("SKIP_EXTERNAL");
  });

  it("does not turn a generic empty result into an external outage", () => {
    const verdict = classifyLiveRun({
      ...base,
      stepCount: 0,
      panelText:
        "AI-guided journey No supported relationship connects these steps.",
    });
    expect(verdict.verdict).toBe("FAIL");
  });

  it("still passes when the model quotes evidence without support badges but persistence is shown", () => {
    const verdict = classifyLiveRun({ ...base, supportLevels: ["inference"] });
    expect(verdict.verdict).toBe("PASS");
  });
});
