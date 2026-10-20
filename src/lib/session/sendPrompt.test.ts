import { describe, expect, it, vi } from "vitest";
import { promptPayload, sendPromptToTerminal } from "./sendPrompt";

vi.mock("../../terminalRegistry", () => ({ getTerminal: () => undefined }));

describe("sendPrompt", () => {
  it("wraps the prompt in a bracketed paste when asked", () => {
    expect(promptPayload("a\nb", true)).toBe("\u001b[200~a\nb\u001b[201~");
    expect(promptPayload("a\r\nb", false)).toBe("a b");
  });

  it("pastes, then presses Enter", async () => {
    const write = vi.fn(async () => undefined);
    await sendPromptToTerminal("t-1", "do T-2", { write });
    expect(write.mock.calls).toEqual([
      ["t-1", "\u001b[200~do T-2\u001b[201~"],
      ["t-1", "\r"],
    ]);
  });
});
