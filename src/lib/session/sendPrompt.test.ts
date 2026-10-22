import { describe, expect, it } from "vitest";
import { promptPayload } from "./sendPrompt";

describe("sendPrompt", () => {
  it("wraps the prompt in a bracketed paste when asked", () => {
    expect(promptPayload("a\nb", true)).toBe("\u001b[200~a\nb\u001b[201~");
    expect(promptPayload("a\r\nb", false)).toBe("a b");
  });
});
