import { describe, expect, it } from "vitest";
import { isEligiblePath } from "./file-filter";

describe("index eligibility", () => {
  it.each([
    ["backend/app/bookings.py", true],
    ["frontend/dist/assets/booking.js", true],
    ["src/App.tsx", true],
    ["package.json", true],
    ["node_modules/fastapi/index.py", false],
    [".git/config", false],
    ["assets/logo.svg", false],
    ["backend/secrets.py", false],
    ["pnpm-lock.yaml", false],
    ["docs/guide.md", true],
  ])("decides %s as %s", (path, eligible) => {
    expect(isEligiblePath(path)).toBe(eligible);
  });
});
