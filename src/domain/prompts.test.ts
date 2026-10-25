import { describe, expect, it } from "vitest";
import { fillPrompt, promptTitle } from "./prompts";

describe("fillPrompt", () => {
  it("Given a prompt with the project placeholder, when filling it, then the project name is filled in", () => {
    expect(fillPrompt("Review {project} now", { project: "api" })).toBe("Review api now");
    expect(fillPrompt("Review {project}", {})).toBe("Review this project");
  });
});

describe("promptTitle", () => {
  it("Given a title, when deriving the prompt title, then it keeps the trimmed title", () => {
    expect(promptTitle("  Flaky  ", "Fix the flaky test")).toBe("Flaky");
  });

  it("Given no title, when deriving the prompt title, then it uses the first six words of the body", () => {
    expect(promptTitle(" ", "Fix the flaky login test please now")).toBe("Fix the flaky login test please");
  });

  it("Given no title and an empty body, when deriving the prompt title, then it falls back to Prompt", () => {
    expect(promptTitle("", "   ")).toBe("Prompt");
  });
});
