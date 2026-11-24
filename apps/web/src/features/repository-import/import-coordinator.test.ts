import { describe, expect, it } from "vitest";
import { createImportCoordinator } from "./import-coordinator";
describe("import coordination", () => {
  it("prevents an older import from replacing the newer selection", () => {
    const coordinator = createImportCoordinator();
    const first = coordinator.begin();
    expect(first()).toBe(true);
    const second = coordinator.begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });
});
