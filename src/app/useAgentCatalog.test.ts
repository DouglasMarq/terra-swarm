// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentInfo } from "../domain/agent.model";

const apiMock = vi.hoisted(() => ({
  detectAgents: vi.fn<() => Promise<AgentInfo[]>>(),
}));

vi.mock("../api", () => ({ api: apiMock }));

import { useAgentCatalog } from "./useAgentCatalog";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("useAgentCatalog", () => {
  it("Given installed agents, when detection finishes, then they are listed and only available ones report as available", async () => {
    apiMock.detectAgents.mockResolvedValue([
      { id: "codex", label: "Codex", isAvailable: true },
      { id: "claude", label: "Claude Code", isAvailable: false },
    ]);
    const { result } = renderHook(() => useAgentCatalog());

    await act(() => result.current.detect());
    await result.current.whenReady();

    expect(result.current.agents).toHaveLength(2);
    expect(result.current.isAvailable("codex")).toBe(true);
    expect(result.current.isAvailable("claude")).toBe(false);
  });

  it("Given detection fails, when it finishes, then the list stays empty", async () => {
    apiMock.detectAgents.mockRejectedValue(new Error("no PATH"));
    const { result } = renderHook(() => useAgentCatalog());

    await act(() => result.current.detect());

    expect(result.current.agents).toEqual([]);
    expect(result.current.isAvailable("codex")).toBe(false);
  });
});
