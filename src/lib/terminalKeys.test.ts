// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { isPlainShiftEnter } from "./terminalKeys";

function key(init: KeyboardEventInit & { type?: string }): KeyboardEvent {
  return new KeyboardEvent(init.type ?? "keydown", init);
}

describe("isPlainShiftEnter", () => {
  it("Given Shift+Enter on keydown or keypress, when checked, then it matches", () => {
    expect(isPlainShiftEnter(key({ key: "Enter", shiftKey: true }))).toBe(true);
    expect(isPlainShiftEnter(key({ type: "keypress", key: "Enter", shiftKey: true }))).toBe(true);
  });

  it("Given Enter without Shift, with another modifier or on keyup, when checked, then it does not match", () => {
    expect(isPlainShiftEnter(key({ key: "Enter" }))).toBe(false);
    expect(isPlainShiftEnter(key({ key: "Enter", shiftKey: true, metaKey: true }))).toBe(false);
    expect(isPlainShiftEnter(key({ key: "Enter", shiftKey: true, ctrlKey: true }))).toBe(false);
    expect(isPlainShiftEnter(key({ key: "Enter", shiftKey: true, altKey: true }))).toBe(false);
    expect(isPlainShiftEnter(key({ type: "keyup", key: "Enter", shiftKey: true }))).toBe(false);
  });
});
