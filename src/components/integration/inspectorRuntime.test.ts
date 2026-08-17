import { describe, expect, it } from "vitest";
import {
  INITIAL_INSPECTOR_RUNTIME_STATE,
  reduceInspectorRuntime,
} from "./inspectorRuntime";

const liveInfo = {
  id: "pty-one",
  pid: 99,
  cols: 120,
  rows: 40,
  running: true,
  reaped: false,
  generation: 4,
};

describe("reduceInspectorRuntime", () => {
  it("represents a live focused PTY with its runtime facts", () => {
    const requested = reduceInspectorRuntime(INITIAL_INSPECTOR_RUNTIME_STATE, {
      type: "request",
      terminalId: "pty-one",
      requestId: 1,
    });
    const ready = reduceInspectorRuntime(requested, {
      type: "success",
      terminalId: "pty-one",
      requestId: 1,
      info: liveInfo,
    });
    expect(ready).toMatchObject({ status: "ready", info: liveInfo });
  });

  it("distinguishes an ended or unavailable runtime from a request error", () => {
    const requested = reduceInspectorRuntime(INITIAL_INSPECTOR_RUNTIME_STATE, {
      type: "request",
      terminalId: "pty-ended",
      requestId: 2,
    });
    const unavailable = reduceInspectorRuntime(requested, {
      type: "success",
      terminalId: "pty-ended",
      requestId: 2,
      info: null,
    });
    expect(unavailable).toMatchObject({ status: "unavailable", info: null, error: null });

    const error = reduceInspectorRuntime(
      reduceInspectorRuntime(INITIAL_INSPECTOR_RUNTIME_STATE, {
        type: "request",
        terminalId: "pty-error",
        requestId: 3,
      }),
      { type: "failure", terminalId: "pty-error", requestId: 3, error: "offline" },
    );
    expect(error).toMatchObject({ status: "error", error: "offline" });
  });

  it("ignores a stale response after focus changes quickly", () => {
    const focusedOne = reduceInspectorRuntime(INITIAL_INSPECTOR_RUNTIME_STATE, {
      type: "request",
      terminalId: "pty-one",
      requestId: 4,
    });
    const focusedTwo = reduceInspectorRuntime(focusedOne, {
      type: "request",
      terminalId: "pty-two",
      requestId: 5,
    });
    const stale = reduceInspectorRuntime(focusedTwo, {
      type: "success",
      terminalId: "pty-one",
      requestId: 4,
      info: liveInfo,
    });
    expect(stale).toBe(focusedTwo);
  });
});
