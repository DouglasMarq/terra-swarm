// @vitest-environment jsdom

import { act, render } from "@testing-library/react";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcError } from "../lib/tauri/errors";
import type { FileDropEvent } from "../lib/tauri/fileDrop";
import { TerminalPane } from "./TerminalPane";

interface TerminalMock {
  cols: number;
  rows: number;
  options: { fontSize: number };
  dataHandler?: (data: string) => void;
  keyHandler?: (event: KeyboardEvent) => boolean;
  dispose: ReturnType<typeof vi.fn>;
  paste: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
}

interface ResizeObserverMock {
  trigger: () => void;
  disconnect: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => ({
  api: {
    resizeTerminal: vi.fn(),
    writeTerminal: vi.fn(),
    terminalBacklog: vi.fn(),
  },
  terminals: [] as TerminalMock[],
  fitAddons: [] as Array<{ proposeDimensions: ReturnType<typeof vi.fn>; fit: ReturnType<typeof vi.fn> }>,
  resizeObservers: [] as ResizeObserverMock[],
  frames: [] as Array<{ id: number; callback: FrameRequestCallback }>,
  nextFrameId: 0,
  geometry: { width: 800, height: 480 },
  fitDimensions: { cols: 100, rows: 24 },
  fileDropHandlers: [] as Array<(event: FileDropEvent) => void>,
  fileDropUnlisten: vi.fn(),
}));

vi.mock("../api", () => ({ api: mocks.api }));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
}));

vi.mock("../lib/tauri/fileDrop", () => ({
  onFileDrop: vi.fn(async (handler: (event: FileDropEvent) => void) => {
    mocks.fileDropHandlers.push(handler);
    return mocks.fileDropUnlisten;
  }),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal implements TerminalMock {
    cols = 80;
    rows = 24;
    options: { fontSize: number };
    dataHandler?: (data: string) => void;
    keyHandler?: (event: KeyboardEvent) => boolean;
    dispose = vi.fn();
    paste = vi.fn();
    focus = vi.fn();

    constructor(options: { fontSize?: number }) {
      this.options = { fontSize: options.fontSize ?? 14 };
      mocks.terminals.push(this);
    }

    loadAddon(addon: { terminal?: { cols: number; rows: number } }) {
      addon.terminal = this;
    }

    open = vi.fn();

    attachCustomKeyEventHandler = vi.fn((handler: (event: KeyboardEvent) => boolean) => {
      this.keyHandler = handler;
    });

    onData = vi.fn((handler: (data: string) => void) => {
      this.dataHandler = handler;
      return { dispose: vi.fn() };
    });

    write = vi.fn((_data: string, callback?: () => void) => {
      callback?.();
    });
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    terminal?: { cols: number; rows: number };
    proposeDimensions = vi.fn(() => {
      if (mocks.geometry.width <= 0 || mocks.geometry.height <= 0) {
        return { cols: 2, rows: 1 };
      }
      return { ...mocks.fitDimensions };
    });
    fit = vi.fn(() => {
      if (!this.terminal) return;
      const dimensions = this.proposeDimensions();
      this.terminal.cols = dimensions.cols;
      this.terminal.rows = dimensions.rows;
    });

    constructor() {
      mocks.fitAddons.push(this);
    }
  },
}));

type PaneProps = ComponentProps<typeof TerminalPane>;

const defaultProps: PaneProps = {
  id: "pty-1",
  command: "luna-max",
  fontSize: 14,
  hasExited: false,
  isExpanded: false,
  basis: 100,
  height: "100%",
  isEntering: false,
  isDragOver: false,
  notifications: 0,
  isFocused: true,
  onClearNotifications: vi.fn(),
  onFocus: vi.fn(),
  onToggleExpand: vi.fn(),
  onRestart: vi.fn(),
  onClose: vi.fn(),
};

function pane(overrides: Partial<PaneProps> = {}) {
  return render(<TerminalPane {...defaultProps} {...overrides} />);
}

function rect(width: number, height: number): DOMRect {
  return {
    bottom: height,
    height,
    left: 0,
    right: width,
    top: 0,
    width,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

async function flushFrames(): Promise<void> {
  await act(async () => {
    const pending = mocks.frames.splice(0);
    pending.forEach(({ callback }) => callback(performance.now()));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function rerenderPane(view: ReturnType<typeof pane>, overrides: Partial<PaneProps>) {
  view.rerender(<TerminalPane {...defaultProps} {...overrides} />);
}

beforeEach(() => {
  mocks.api.resizeTerminal.mockReset().mockResolvedValue(undefined);
  mocks.api.writeTerminal.mockReset().mockResolvedValue(undefined);
  mocks.api.terminalBacklog.mockReset().mockResolvedValue({ data: "", total: 0 });
  mocks.terminals.length = 0;
  mocks.fitAddons.length = 0;
  mocks.resizeObservers.length = 0;
  mocks.frames.length = 0;
  mocks.nextFrameId = 0;
  mocks.geometry.width = 800;
  mocks.geometry.height = 480;
  mocks.fitDimensions.cols = 100;
  mocks.fitDimensions.rows = 24;
  mocks.fileDropHandlers.length = 0;
  mocks.fileDropUnlisten.mockReset();

  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      const id = ++mocks.nextFrameId;
      mocks.frames.push({ id, callback });
      return id;
    },
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    value: (id: number) => {
      const index = mocks.frames.findIndex((frame) => frame.id === id);
      if (index >= 0) mocks.frames.splice(index, 1);
    },
  });

  class TestResizeObserver implements ResizeObserver {
    private readonly callback: ResizeObserverCallback;
    disconnect = vi.fn();

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      mocks.resizeObservers.push(this);
    }

    observe(_target: Element) {}

    unobserve(_target: Element) {}

    trigger() {
      this.callback([], this);
    }
  }

  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    value: TestResizeObserver,
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("pane-body")) return rect(mocks.geometry.width, mocks.geometry.height);
    return rect(0, 0);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TerminalPane geometry and PTY lifecycle", () => {
  it("Given a visible mount, when the pane measures it, then valid xterm dimensions are sent", async () => {
    pane();
    await flushFrames();

    expect(mocks.api.resizeTerminal).toHaveBeenCalledTimes(1);
    expect(mocks.api.resizeTerminal).toHaveBeenCalledWith("pty-1", 100, 24);
  });

  it("Given a hidden mount, when FitAddon falls back to 2x1, then the size is never forwarded", async () => {
    mocks.geometry.width = 0;
    mocks.geometry.height = 0;
    pane({ isHidden: true });
    await flushFrames();

    expect(mocks.api.resizeTerminal).not.toHaveBeenCalled();
  });

  it("Given a hidden pane, when it becomes visible or the layout or font changes, then it refits", async () => {
    mocks.geometry.width = 0;
    mocks.geometry.height = 0;
    const view = pane({ isHidden: true });
    await flushFrames();
    expect(mocks.api.resizeTerminal).not.toHaveBeenCalled();

    mocks.geometry.width = 1200;
    mocks.geometry.height = 600;
    mocks.fitDimensions.cols = 150;
    mocks.fitDimensions.rows = 30;
    rerenderPane(view, { isHidden: false, basis: 50, height: "50%", fontSize: 16 });
    await flushFrames();

    expect(mocks.api.resizeTerminal).toHaveBeenCalledTimes(1);
    expect(mocks.api.resizeTerminal).toHaveBeenLastCalledWith("pty-1", 150, 30);
    expect(mocks.terminals[0]?.options.fontSize).toBe(16);
  });

  it("Given observer, window, focus and visibility signals, when they arrive together, then they are coalesced", async () => {
    pane();
    await flushFrames();
    mocks.api.resizeTerminal.mockClear();
    mocks.geometry.width = 1000;
    mocks.fitDimensions.cols = 125;
    mocks.resizeObservers[0]?.trigger();
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await flushFrames();

    expect(mocks.api.resizeTerminal).toHaveBeenCalledTimes(1);
    expect(mocks.api.resizeTerminal).toHaveBeenCalledWith("pty-1", 125, 24);
  });

  it("Given an exited terminal, when it restarts, then its scrollback stayed mounted without resize or write and it refits", async () => {
    const view = pane();
    await flushFrames();
    mocks.api.resizeTerminal.mockClear();
    mocks.api.writeTerminal.mockClear();
    const terminal = mocks.terminals[0];

    rerenderPane(view, { hasExited: true });
    terminal?.dataHandler?.("echo should not be sent after exit");
    terminal?.keyHandler?.(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.api.writeTerminal).not.toHaveBeenCalled();

    mocks.resizeObservers[0]?.trigger();
    window.dispatchEvent(new Event("focus"));
    await flushFrames();
    expect(view.container.querySelector(".pane-body")).toBeInTheDocument();
    expect(view.container).toHaveTextContent("Processo encerrado");
    expect(mocks.api.resizeTerminal).not.toHaveBeenCalled();

    rerenderPane(view, { hasExited: false });
    await flushFrames();
    expect(mocks.api.resizeTerminal).toHaveBeenCalledTimes(1);
    expect(mocks.api.resizeTerminal).toHaveBeenCalledWith("pty-1", 100, 24);
  });

  it("Given a mounted pane, when it unmounts, then observers, event listeners and pending frames are cleaned up", async () => {
    const view = pane();
    const terminal = mocks.terminals[0];
    view.unmount();
    await flushFrames();
    mocks.resizeObservers[0]?.trigger();
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await flushFrames();

    expect(mocks.api.resizeTerminal).not.toHaveBeenCalled();
    expect(mocks.api.writeTerminal).not.toHaveBeenCalled();
    expect(mocks.resizeObservers[0]?.disconnect).toHaveBeenCalledTimes(1);
    expect(terminal?.dispose).toHaveBeenCalledTimes(1);
  });
});

describe("TerminalPane input", () => {
  it("Given a busy input queue, when a key is typed, then the keystroke is retried until it is written", async () => {
    mocks.api.writeTerminal
      .mockRejectedValueOnce(new IpcError({ code: "busy", message: "input queue full" }))
      .mockResolvedValue(undefined);
    pane();
    mocks.terminals[0]?.dataHandler?.("a");

    await vi.waitFor(() => expect(mocks.api.writeTerminal).toHaveBeenCalledTimes(2));
    expect(mocks.api.writeTerminal).toHaveBeenLastCalledWith("pty-1", "a");
  });

  it("Given a write that fails for another reason, when a key is typed, then it warns once without retrying", async () => {
    const failure = new IpcError({ code: "other", message: "terminal pty-1 input closed" });
    mocks.api.writeTerminal.mockRejectedValue(failure);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    pane();
    mocks.terminals[0]?.dataHandler?.("a");

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn.mock.calls[0]).toContain(failure);
    expect(mocks.api.writeTerminal).toHaveBeenCalledTimes(1);
  });
});

describe("TerminalPane file drop", () => {
  const position = new PhysicalPosition(120, 80);

  function pointAt(element: Element | null) {
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => element) });
  }

  async function dropOnPane(overrides: Partial<PaneProps> = {}, target: "pane" | "outside" = "pane") {
    const onFocus = vi.fn();
    const view = pane({ onFocus, ...overrides });
    await vi.waitFor(() => expect(mocks.fileDropHandlers).toHaveLength(1));
    pointAt(target === "pane" ? view.container.querySelector(".pane-body") : document.body);
    const send = (event: FileDropEvent) => act(() => mocks.fileDropHandlers[0]?.(event));
    return { view, onFocus, send, terminal: mocks.terminals[0] };
  }

  it("Given a running pane, when a file is dropped on it, then its escaped path is pasted and the pane is focused", async () => {
    const { onFocus, send, terminal } = await dropOnPane();

    send({ type: "drop", paths: ["/Users/me/Screen Shot.png"], position });

    expect(terminal?.paste).toHaveBeenCalledWith("/Users/me/Screen\\ Shot.png ");
    expect(terminal?.focus).toHaveBeenCalled();
    expect(onFocus).toHaveBeenCalled();
  });

  it("Given a drop outside the pane, when the drop lands, then nothing is pasted", async () => {
    const { send, terminal } = await dropOnPane({}, "outside");

    send({ type: "drop", paths: ["/Users/me/shot.png"], position });

    expect(terminal?.paste).not.toHaveBeenCalled();
  });

  it("Given an exited pane, when a file is dropped on it, then nothing is pasted", async () => {
    const { send, terminal } = await dropOnPane({ hasExited: true });

    send({ type: "drop", paths: ["/Users/me/shot.png"], position });

    expect(terminal?.paste).not.toHaveBeenCalled();
  });

  it("Given a drag over the pane, when the drag leaves, then the highlight is removed", async () => {
    const { view, send } = await dropOnPane();
    const root = view.container.querySelector(".pane");

    send({ type: "enter", paths: ["/Users/me/shot.png"], position });
    expect(root?.classList.contains("drop-target")).toBe(true);

    send({ type: "leave" });
    expect(root?.classList.contains("drop-target")).toBe(false);
  });

  it("Given a mounted pane, when it unmounts, then it stops listening for drops", async () => {
    const { view } = await dropOnPane();

    view.unmount();

    expect(mocks.fileDropUnlisten).toHaveBeenCalledTimes(1);
  });
});
