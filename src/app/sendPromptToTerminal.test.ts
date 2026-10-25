import { describe, expect, it, vi } from "vitest";
import { writeTerminal } from "../lib/tauri/pty";
import { nudgeAgent, sendPromptToTerminal } from "./sendPromptToTerminal";

vi.mock("../terminalRegistry", () => ({ getTerminal: () => undefined }));
vi.mock("../lib/tauri/pty", () => ({ writeTerminal: vi.fn(async () => undefined) }));

describe("sendPromptToTerminal", () => {
  it("pastes, then presses Enter", async () => {
    const write = vi.fn(async () => undefined);
    await sendPromptToTerminal("t-1", "do T-2", { write });
    expect(write.mock.calls).toEqual([
      ["t-1", "\u001b[200~do T-2\u001b[201~"],
      ["t-1", "\r"],
    ]);
  });

  it("given submit is false, pastes without pressing Enter", async () => {
    const write = vi.fn(async () => undefined);
    await sendPromptToTerminal("t-1", "draft", { submit: false, write });
    expect(write.mock.calls).toEqual([["t-1", "\u001b[200~draft\u001b[201~"]]);
  });
});

describe("nudgeAgent", () => {
  it("given the terminal refuses the prompt, warns instead of failing", async () => {
    vi.mocked(writeTerminal).mockRejectedValueOnce(new Error("closed"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    nudgeAgent({ workspace_id: "ws-1", terminal_id: "t-1", prompt: "do T-2" });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("failed to wake t-1:", expect.any(Error)));
    warn.mockRestore();
  });
});
