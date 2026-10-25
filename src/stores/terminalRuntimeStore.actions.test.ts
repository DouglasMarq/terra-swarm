import { afterEach, describe, expect, it } from "vitest";
import type { ResumeItem } from "../domain/terminal.model";
import { useTerminalRuntimeStore } from "./terminalRuntimeStore";

const runtime = () => useTerminalRuntimeStore.getState();

function resumeItem(terminalId: string): ResumeItem {
  return { terminalId, wsId: "ws-1", wsName: "terra", cwd: "/repo", command: "claude", agentId: "claude", resumeCommand: "claude --continue" };
}

describe("terminal runtime store actions", () => {
  afterEach(() => runtime().reset());

  it("Given per-terminal slices, when setting and clearing them one by one, then only the cleared entry goes away", () => {
    runtime().setExited({ "pty-1": 0, "pty-2": 1 });
    runtime().setContextUsage({ "pty-1": 40 });
    runtime().setTitle({ id: "pty-1", workspace_id: "ws-1", title: "build" });
    runtime().setNotifications({ "pty-1": 2 });
    runtime().setNotifications((previous) => ({ ...previous, "pty-2": 1 }));

    runtime().clearExited("pty-1");
    runtime().clearContextUsage("pty-1");
    runtime().clearTitle("pty-1");
    runtime().clearNotificationCount("pty-1");

    expect(runtime().exited).toEqual({ "pty-2": 1 });
    expect(runtime().contextUsage).toEqual({});
    expect(runtime().titles).toEqual({});
    expect(runtime().notifications).toEqual({ "pty-2": 1 });
  });

  it("Given a slice without the key, when clearing it, then the same record is kept", () => {
    const exited = { "pty-2": 1 };
    runtime().setExited(exited);

    runtime().clearExited("pty-9");

    expect(runtime().exited).toBe(exited);
  });

  it("Given a notification without messages, when it arrives, then only the unread count grows", () => {
    runtime().addNotification({ id: "pty-1", workspace_id: "ws-1", count: 3, messages: [] });

    expect(runtime().notifications).toEqual({ "pty-1": 3 });
    expect(runtime().notifItems).toEqual([]);
  });

  it("Given unread items from two terminals, when marking one terminal read, then only its items are read", () => {
    runtime().addNotification({ id: "pty-1", workspace_id: "ws-1", count: 1, messages: ["one"] });
    runtime().addNotification({ id: "pty-2", workspace_id: "ws-1", count: 1, messages: ["two"] });

    runtime().markTerminalRead("pty-1");

    const readById = Object.fromEntries(runtime().notifItems.map((item) => [item.terminalId, item.isRead]));
    expect(readById).toEqual({ "pty-1": true, "pty-2": false });
  });

  it("Given a terminal with nothing unread, when marking it read, then the state is unchanged", () => {
    runtime().addNotification({ id: "pty-1", workspace_id: "ws-1", count: 1, messages: ["one"] });
    runtime().markTerminalRead("pty-1");
    const items = runtime().notifItems;

    runtime().markTerminalRead("pty-1");

    expect(runtime().notifItems).toBe(items);
  });

  it("Given unread items, when marking all read twice, then everything is read and the second pass keeps the list", () => {
    runtime().addNotification({ id: "pty-1", workspace_id: "ws-1", count: 2, messages: ["one", "two"] });

    runtime().markAllRead();
    const items = runtime().notifItems;
    runtime().markAllRead();

    expect(items.every((item) => item.isRead)).toBe(true);
    expect(runtime().notifItems).toBe(items);
    expect(runtime().notifications).toEqual({});
  });

  it("Given notifications, when clearing all, then items and counts are empty", () => {
    runtime().addNotification({ id: "pty-1", workspace_id: "ws-1", count: 1, messages: ["one"] });
    runtime().setNotifItems((items) => [...items]);

    runtime().clearAllNotifications();

    expect(runtime().notifItems).toEqual([]);
    expect(runtime().notifications).toEqual({});
  });

  it("Given an update notice already shown, when a newer version is announced, then only the newest notice stays", () => {
    runtime().notifyUpdateAvailable("1.1.0", "1.0.0");
    runtime().notifyUpdateAvailable("1.2.0", "1.0.0");

    const updates = runtime().notifItems.filter((item) => item.isUpdate);
    expect(updates).toHaveLength(1);
    expect(updates[0].message).toContain("1.2.0");
  });

  it("Given resume items, when dropping each, then the list shrinks and becomes null when empty", () => {
    runtime().dropResumeItem("pty-1");
    expect(runtime().resumeItems).toBeNull();

    runtime().setResumeItems([resumeItem("pty-1"), resumeItem("pty-2")]);
    runtime().setResumeSavedAt(123);
    runtime().dropResumeItem("pty-1");
    expect(runtime().resumeItems?.map((item) => item.terminalId)).toEqual(["pty-2"]);

    runtime().dropResumeItem("pty-2");
    expect(runtime().resumeItems).toBeNull();
    expect(runtime().resumeSavedAt).toBe(123);
  });

  it("Given several terminals, when clearing a batch, then their slices go and the others stay", () => {
    runtime().setExited({ "pty-1": 0, "pty-2": 0, "pty-3": 0 });
    runtime().setTitles({ "pty-1": "a" });
    runtime().addNotification({ id: "pty-2", workspace_id: "ws-1", count: 1, messages: ["x"] });

    runtime().clearTerminals(["pty-1", "pty-2"]);

    expect(runtime().exited).toEqual({ "pty-3": 0 });
    expect(runtime().titles).toEqual({});
    expect(runtime().notifItems).toEqual([]);
  });

  it("Given an empty batch, when clearing terminals, then the state is unchanged", () => {
    runtime().setExited({ "pty-1": 0 });
    const before = runtime();

    runtime().clearTerminals([]);

    expect(runtime()).toBe(before);
  });

  it("Given the same branches, when setting them again, then the state object is kept", () => {
    runtime().setBranches({ "ws-1": "main" });
    const before = runtime();

    runtime().setBranches({ "ws-1": "main" });
    expect(runtime()).toBe(before);

    runtime().setBranches((branches) => ({ ...branches, "ws-2": "dev" }));
    expect(runtime().branches).toEqual({ "ws-1": "main", "ws-2": "dev" });
  });
});
