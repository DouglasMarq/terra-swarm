import { describe, expect, it } from "vitest";
import { createMountFocusQueue } from "./mountFocusQueue";

describe("mount/focus queue", () => {
  it("runs mount then focus and serializes the next effect", async () => {
    const events: string[] = [];
    const queue = createMountFocusQueue(() => 0);
    const first = queue.enqueue({
      id: "first",
      mount: () => events.push("first:mount"),
      focus: () => events.push("first:focus"),
    });
    const second = queue.enqueue({
      id: "second",
      mount: () => events.push("second:mount"),
      focus: () => events.push("second:focus"),
    });

    expect(await first).toMatchObject({ id: "first", status: "completed" });
    expect(await second).toMatchObject({ id: "second", status: "completed" });
    expect(events).toEqual(["first:mount", "first:focus", "second:mount", "second:focus"]);
  });

  it("does not run focus when mount fails and continues the queue", async () => {
    const events: string[] = [];
    const queue = createMountFocusQueue(() => 0);
    const failed = queue.enqueue({
      id: "failed",
      mount: () => {
        events.push("failed:mount");
        throw new Error("cannot mount");
      },
      focus: () => events.push("failed:focus"),
    });
    const next = queue.enqueue({ id: "next", focus: () => events.push("next:focus") });

    expect(await failed).toMatchObject({ id: "failed", status: "failed", phase: "mount" });
    expect(await next).toMatchObject({ id: "next", status: "completed" });
    expect(events).toEqual(["failed:mount", "next:focus"]);
  });

  it("coalesces stale pending focus requests", async () => {
    const events: string[] = [];
    const queue = createMountFocusQueue(() => 0);
    const gate = new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    const first = queue.enqueue({
      id: "blocking",
      mount: async () => gate,
    });
    const stale = queue.enqueue({ id: "stale", coalesceKey: "terminal-1", focus: () => events.push("stale") });
    const current = queue.enqueue({ id: "current", coalesceKey: "terminal-1", focus: () => events.push("current") });

    expect((await stale).status).toBe("cancelled");
    expect(await first).toMatchObject({ status: "completed" });
    expect(await current).toMatchObject({ status: "completed" });
    expect(events).toEqual(["current"]);
  });

  it("given a clock, stamps start and finish times from it", async () => {
    let time = 100;
    const queue = createMountFocusQueue(() => time++);
    expect(await queue.enqueue({ id: "one", focus: () => undefined })).toMatchObject({ status: "completed", startedAt: 100, finishedAt: 101 });
  });
});

