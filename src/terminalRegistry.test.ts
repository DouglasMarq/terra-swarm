import type { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { getTerminal, registerTerminal, unregisterTerminal } from "./terminalRegistry";

function fakeTerminal(): Terminal {
  const partial: Pick<Terminal, "focus"> = { focus: () => undefined };
  // The registry only stores and returns the instance; a live xterm needs a DOM renderer.
  return partial as Terminal;
}

describe("terminalRegistry", () => {
  it("Given a replaced terminal, when the old instance unregisters, then the new one stays registered", () => {
    const old = fakeTerminal();
    const current = fakeTerminal();
    registerTerminal("pty-1", old);
    registerTerminal("pty-1", current);

    unregisterTerminal("pty-1", old);
    expect(getTerminal("pty-1")).toBe(current);

    unregisterTerminal("pty-1", current);
    expect(getTerminal("pty-1")).toBeUndefined();
  });
});
