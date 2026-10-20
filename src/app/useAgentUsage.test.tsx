// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTokenUsage } from "../types";

const mcp = vi.hoisted(() => ({ agentUsage: vi.fn() }));
vi.mock("../lib/tauri/mcp", () => ({ mcpApi: mcp }));

import { useUsageStore } from "../stores/usageStore";
import { USAGE_REFRESH_MS, useAgentUsage } from "./useAgentUsage";

const usage: AgentTokenUsage = {
  terminal_id: "t-1",
  agent: "claude",
  input_tokens: 10,
  output_tokens: 20,
  cache_read_tokens: 30,
  cache_write_tokens: 40,
  turns: 2,
  model: "model-a",
};

describe("useAgentUsage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useUsageStore.setState({ usage: {} });
    mcp.agentUsage.mockReset().mockResolvedValue([usage]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("given nothing shows the usage, does not read it", async () => {
    renderHook(() => useAgentUsage("ws-1", "t-1", false));
    await act(() => vi.advanceTimersByTimeAsync(USAGE_REFRESH_MS));
    expect(mcp.agentUsage).not.toHaveBeenCalled();
  });

  it("given a shown agent, reads its usage and refreshes it", async () => {
    const { result } = renderHook(() => useAgentUsage("ws-1", "t-1", true));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current).toEqual(usage);
    expect(mcp.agentUsage).toHaveBeenCalledWith("ws-1");

    await act(() => vi.advanceTimersByTimeAsync(USAGE_REFRESH_MS));
    expect(mcp.agentUsage).toHaveBeenCalledTimes(2);
  });

  it("given the usage can't be read, warns and shows none", async () => {
    mcp.agentUsage.mockRejectedValue("usage unavailable");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() => useAgentUsage("ws-1", "t-1", true));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current).toBeNull();
    expect(warn).toHaveBeenCalledWith("token usage unavailable:", "usage unavailable");
    warn.mockRestore();
  });
});
