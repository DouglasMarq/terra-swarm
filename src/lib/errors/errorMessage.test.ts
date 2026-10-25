import { describe, expect, it } from "vitest";
import { errorMessage } from "./errorMessage";

describe("errorMessage", () => {
  it("Given an Error, when reading its message, then the message is returned", () => {
    expect(errorMessage(new Error("worktree is busy"), "fallback")).toBe("worktree is busy");
  });

  it("Given a rejected IPC string, when reading its message, then the string is returned", () => {
    expect(errorMessage("file changed on disk")).toBe("file changed on disk");
  });

  it("Given an Error without a message, when reading its message, then the fallback is returned", () => {
    expect(errorMessage(new Error("  "), "could not load")).toBe("could not load");
  });

  it("Given a blank string and a fallback, when reading its message, then the fallback is returned", () => {
    expect(errorMessage("", "")).toBe("");
  });

  it("Given another value and no fallback, when reading its message, then the value is returned as text", () => {
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(undefined)).toBe("undefined");
  });
});
