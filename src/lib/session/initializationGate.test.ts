import { describe, expect, it, vi } from "vitest";
import { createInitializationGate } from "./initializationGate";

describe("initialization gate", () => {
  it("coalesces StrictMode/concurrent attempts and allows retry after failure", async () => {
    const gate = createInitializationGate();
    const firstTask = vi.fn(async () => {
      throw new Error("backend indisponível");
    });
    const first = gate.run(firstTask);
    const duplicate = gate.run(firstTask);

    expect(duplicate).toBe(first);
    expect(firstTask).toHaveBeenCalledOnce();
    await expect(first).rejects.toThrow("backend indisponível");

    const retryTask = vi.fn(async () => undefined);
    await expect(gate.run(retryTask)).resolves.toBeUndefined();
    expect(retryTask).toHaveBeenCalledOnce();
  });

  it("does not start a second attempt while the first is still pending", async () => {
    const gate = createInitializationGate();
    let release!: () => void;
    const task = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));

    const first = gate.run(task);
    const duplicate = gate.run(() => Promise.resolve());
    expect(gate.isRunning()).toBe(true);
    expect(duplicate).toBe(first);
    expect(task).toHaveBeenCalledOnce();

    release();
    await first;
    expect(gate.isRunning()).toBe(false);
  });
});
