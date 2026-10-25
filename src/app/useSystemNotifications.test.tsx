// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../domain/workspace.model";

const tauri = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  unlisten: vi.fn(),
  setBadgeCount: vi.fn(),
  sendNotification: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    tauri.handlers.set(name, handler);
    return tauri.unlisten;
  },
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: tauri.setBadgeCount }) }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: async () => true,
  requestPermission: async () => "granted",
  sendNotification: tauri.sendNotification,
}));

import { translateNow } from "../i18n";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";
import { useSystemNotifications } from "./useSystemNotifications";

const workspaces: Workspace[] = [
  { id: "ws-1", name: "terra", cwd: "/repo", terminals: [{ id: "pty-1", command: "claude", width: null }, { id: "pty-2", command: "codex", width: null }] },
];

function emit(name: string, payload: unknown) {
  act(() => tauri.handlers.get(name)?.({ payload }));
}

describe("useSystemNotifications", () => {
  let hasFocus: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tauri.handlers.clear();
    tauri.unlisten.mockReset();
    tauri.sendNotification.mockReset();
    tauri.setBadgeCount.mockReset().mockResolvedValue(undefined);
    hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    usePreferencesStore.setState({ isSystemNotificationsEnabled: true, agentNames: { "pty-1": "Vega" } });
  });

  afterEach(() => {
    hasFocus.mockRestore();
    useTerminalRuntimeStore.getState().reset();
  });

  it("Given agents waiting for input, when notifications are on, then the badge shows how many wait, and clears when off", async () => {
    const { rerender } = renderHook(() => useSystemNotifications(workspaces));
    act(() => useTerminalRuntimeStore.getState().setNotifications({ "pty-1": 1, "pty-2": 2 }));

    await vi.waitFor(() => expect(tauri.setBadgeCount).toHaveBeenLastCalledWith(2));

    act(() => usePreferencesStore.setState({ isSystemNotificationsEnabled: false }));
    rerender();
    await vi.waitFor(() => expect(tauri.setBadgeCount).toHaveBeenLastCalledWith(undefined));
  });

  it("Given the badge cannot be set, when the count changes, then the failure is only logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    tauri.setBadgeCount.mockRejectedValue(new Error("no dock"));

    renderHook(() => useSystemNotifications(workspaces));

    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });

  it("Given the app in the background, when an agent asks for attention, then a named system notification is shown once per cooldown", async () => {
    renderHook(() => useSystemNotifications(workspaces));

    emit("agent-attention", { terminal_id: "pty-1", workspace_id: "ws-1", message: "Approve the plan?" });
    emit("agent-attention", { terminal_id: "pty-1", workspace_id: "ws-1", message: "Again" });

    await vi.waitFor(() => expect(tauri.sendNotification).toHaveBeenCalledTimes(1));
    expect(tauri.sendNotification).toHaveBeenCalledWith({ title: translateNow("notifications.needsYouTitle", { name: "Vega · claude" }), body: "Approve the plan?" });
  });

  it("Given a terminal notification without text for an unlabelled terminal, when it arrives, then the id and the default body are used", async () => {
    renderHook(() => useSystemNotifications([]));

    emit("terminal-notification", { id: "pty-9", workspace_id: "ws-1", count: 1, messages: [] });

    await vi.waitFor(() => expect(tauri.sendNotification).toHaveBeenCalledWith({
      title: translateNow("notifications.needsYouTitle", { name: "pty-9" }),
      body: translateNow("notifications.needsYouBody"),
    }));
  });

  it("Given an attention event without a message, when it arrives, then the default body is used", async () => {
    renderHook(() => useSystemNotifications(workspaces));

    emit("agent-attention", { terminal_id: "pty-2", workspace_id: "ws-1" });

    await vi.waitFor(() => expect(tauri.sendNotification).toHaveBeenCalledWith(expect.objectContaining({ body: translateNow("notifications.needsYouBody") })));
  });

  it("Given the app focused or notifications off, when an agent asks for attention, then nothing is shown, and unmounting stops listening", async () => {
    hasFocus.mockReturnValue(true);
    const { unmount } = renderHook(() => useSystemNotifications(workspaces));
    emit("agent-attention", { terminal_id: "pty-1", workspace_id: "ws-1", message: "hi" });

    hasFocus.mockReturnValue(false);
    act(() => usePreferencesStore.setState({ isSystemNotificationsEnabled: false }));
    emit("agent-attention", { terminal_id: "pty-2", workspace_id: "ws-1", message: "hi" });

    expect(tauri.sendNotification).not.toHaveBeenCalled();
    unmount();
    await vi.waitFor(() => expect(tauri.unlisten).toHaveBeenCalledTimes(2));
  });
});
