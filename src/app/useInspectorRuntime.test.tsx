// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalRuntimeInfo } from "../domain/terminal.model";

const pty = vi.hoisted(() => ({ terminalRuntimeInfo: vi.fn() }));
vi.mock("../lib/tauri/pty", () => ({ ptyApi: pty }));

import { INSPECTOR_RUNTIME_POLL_MS, useInspectorRuntime } from "./useInspectorRuntime";

const info: TerminalRuntimeInfo = { id: "t-1", pid: 42, cols: 120, rows: 40, running: true, reaped: false, generation: 1 };

describe("useInspectorRuntime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pty.terminalRuntimeInfo.mockReset().mockResolvedValue(info);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("given the inspector is closed, does not poll", async () => {
    const { result } = renderHook(() => useInspectorRuntime("t-1", false));
    await act(() => vi.advanceTimersByTimeAsync(INSPECTOR_RUNTIME_POLL_MS));
    expect(pty.terminalRuntimeInfo).not.toHaveBeenCalled();
    expect(result.current.status).toBe("idle");
  });

  it("given the inspector shows a terminal, polls its runtime info", async () => {
    const { result } = renderHook(() => useInspectorRuntime("t-1", true));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current).toMatchObject({ status: "ready", terminalId: "t-1", info });

    await act(() => vi.advanceTimersByTimeAsync(INSPECTOR_RUNTIME_POLL_MS));
    expect(pty.terminalRuntimeInfo).toHaveBeenCalledTimes(2);
  });

  it("given the runtime info can't be read, reports the error", async () => {
    pty.terminalRuntimeInfo.mockRejectedValue("terminal t-1 not found");
    const { result } = renderHook(() => useInspectorRuntime("t-1", true));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current).toMatchObject({ status: "error", error: "terminal t-1 not found" });
  });

  it("given the inspector closes, stops polling and resets", async () => {
    const { result, rerender } = renderHook(({ isActive }) => useInspectorRuntime("t-1", isActive), { initialProps: { isActive: true } });
    await act(() => vi.advanceTimersByTimeAsync(0));
    rerender({ isActive: false });
    await act(() => vi.advanceTimersByTimeAsync(INSPECTOR_RUNTIME_POLL_MS * 2));
    expect(pty.terminalRuntimeInfo).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("idle");
  });
});
