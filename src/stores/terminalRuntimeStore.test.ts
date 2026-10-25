import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_NOTIF_ITEMS,
  useTerminalRuntimeStore,
} from "./terminalRuntimeStore";

describe("terminal runtime store", () => {
  afterEach(() => {
    useTerminalRuntimeStore.getState().reset();
  });

  it("Given notifications, when they arrive, then unread counts and a bounded history are kept", () => {
    const store = useTerminalRuntimeStore.getState();
    store.addNotification({
      id: "term-1",
      workspace_id: "ws-1",
      count: 2,
      messages: ["first", "second"],
    });

    expect(useTerminalRuntimeStore.getState().notifications).toEqual({
      "term-1": 2,
    });
    expect(useTerminalRuntimeStore.getState().notifItems).toHaveLength(2);

    store.addNotification({
      id: "term-1",
      workspace_id: "ws-1",
      count: MAX_NOTIF_ITEMS,
      messages: Array.from(
        { length: MAX_NOTIF_ITEMS },
        (_message, index) => `n-${index}`,
      ),
    });

    expect(useTerminalRuntimeStore.getState().notifItems).toHaveLength(
      MAX_NOTIF_ITEMS,
    );
    expect(useTerminalRuntimeStore.getState().notifItems[0]?.message).toBe(
      "n-49",
    );
  });

  it("Given a closed terminal, when clearing it, then every runtime slice for it is cleared", () => {
    const store = useTerminalRuntimeStore.getState();
    store.setExited({ "term-1": 1 });
    store.setContextUsage({ "term-1": 80 });
    store.setTitles({ "term-1": "Agent" });
    store.addNotification({
      id: "term-1",
      workspace_id: "ws-1",
      count: 1,
      messages: ["done"],
    });

    store.clearTerminal("term-1");

    const state = useTerminalRuntimeStore.getState();
    expect(state.exited).toEqual({});
    expect(state.contextUsage).toEqual({});
    expect(state.titles).toEqual({});
    expect(state.notifications).toEqual({});
    expect(state.notifItems).toEqual([]);
  });
});
