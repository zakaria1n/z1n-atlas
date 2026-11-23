import { describe, expect, it } from "vitest";
import { POST } from "./route";
const call = (body: unknown, origin = "http://localhost:3000") =>
  POST(
    new Request("http://localhost:3000/api/analysis", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
describe("analysis endpoint", () => {
  it("rejects cross-origin requests and unsafe paths", async () => {
    expect((await call({ files: [] }, "https://example.com")).status).toBe(403);
    expect(
      (await call({ files: [{ path: "../secret.ts", content: "" }] })).status,
    ).toBe(400);
    expect(
      (
        await call({
          files: [
            { path: "a.ts", content: "" },
            { path: "a.ts", content: "" },
          ],
        })
      ).status,
    ).toBe(400);
  });
  it("analyzes a bounded snapshot through the Node worker", async () => {
    const response = await call({
      files: [
        { path: "a.ts", content: 'import "./b";' },
        { path: "b.ts", content: "export const b = 1;" },
      ],
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).edges).toHaveLength(1);
  }, 20000);
});
