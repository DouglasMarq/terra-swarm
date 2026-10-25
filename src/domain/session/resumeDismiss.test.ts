import { describe, expect, it, vi } from "vitest";
import { dismissResumeItems } from "./resumeDismiss";

describe("resume dismissal", () => {
  it("Given failed kills, when dismissing resume items, then they stay separate so only confirmed deletions are removed", async () => {
    const kill = vi.fn(async (item: { terminalId: string }) => {
      if (item.terminalId === "term-fail") throw new Error("PTY ocupado");
    });
    const items = [{ terminalId: "term-ok" }, { terminalId: "term-fail" }];

    const results = await dismissResumeItems(items, kill);

    expect(kill).toHaveBeenCalledTimes(2);
    expect(results.filter((result) => result.status === "succeeded").map((result) => result.item.terminalId)).toEqual(["term-ok"]);
    expect(results.filter((result) => result.status === "failed").map((result) => result.item.terminalId)).toEqual(["term-fail"]);
    expect(results.find((result) => result.status === "failed")).toMatchObject({ error: new Error("PTY ocupado") });
  });

  it("Given a failed item, when the backend later succeeds, then the retry removes it", async () => {
    const kill = vi.fn()
      .mockRejectedValueOnce(new Error("temporário"))
      .mockResolvedValueOnce(undefined);
    const item = { terminalId: "term-retry" };

    const first = await dismissResumeItems([item], kill);
    const second = await dismissResumeItems([item], kill);

    expect(first[0]?.status).toBe("failed");
    expect(second[0]?.status).toBe("succeeded");
  });
});
