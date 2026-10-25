import { describe, expect, it } from "vitest";
import { errorMessage } from "./errorMessage";

describe("errorMessage", () => {
  it("given an Error, returns its message", () => {
    expect(errorMessage(new Error("worktree is busy"), "fallback")).toBe("worktree is busy");
  });

  it("given a rejected IPC string, returns the string", () => {
    expect(errorMessage("file changed on disk")).toBe("file changed on disk");
  });

  it("given an Error without a message, returns the fallback", () => {
    expect(errorMessage(new Error("  "), "could not load")).toBe("could not load");
  });

  it("given a blank string and a fallback, returns the fallback", () => {
    expect(errorMessage("", "")).toBe("");
  });

  it("given another value and no fallback, returns the value as text", () => {
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(undefined)).toBe("undefined");
  });
});
