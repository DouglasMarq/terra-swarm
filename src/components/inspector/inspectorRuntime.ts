import type { TerminalRuntimeInfo } from "../../types";

export type InspectorRuntimeStatus = "idle" | "loading" | "ready" | "unavailable" | "error";

export interface InspectorRuntimeState {
  terminalId: string | null;
  requestId: number;
  status: InspectorRuntimeStatus;
  info: TerminalRuntimeInfo | null;
  error: string | null;
}

export type InspectorRuntimeAction =
  | { type: "reset"; requestId: number }
  | { type: "request"; terminalId: string; requestId: number }
  | { type: "success"; terminalId: string; requestId: number; info: TerminalRuntimeInfo | null }
  | { type: "failure"; terminalId: string; requestId: number; error: string };

export const INITIAL_INSPECTOR_RUNTIME_STATE: InspectorRuntimeState = {
  terminalId: null,
  requestId: 0,
  status: "idle",
  info: null,
  error: null,
};

/** Ignore late responses from a previous focused terminal or poll generation. */
function isCurrent(
  state: InspectorRuntimeState,
  terminalId: string,
  requestId: number,
): boolean {
  return state.terminalId === terminalId && state.requestId === requestId;
}

export function reduceInspectorRuntime(
  state: InspectorRuntimeState,
  action: InspectorRuntimeAction,
): InspectorRuntimeState {
  if (action.type === "reset") {
    return {
      ...INITIAL_INSPECTOR_RUNTIME_STATE,
      requestId: action.requestId,
    };
  }
  if (action.type === "request") {
    return {
      terminalId: action.terminalId,
      requestId: action.requestId,
      status: "loading",
      info: null,
      error: null,
    };
  }
  if (!isCurrent(state, action.terminalId, action.requestId)) return state;
  if (action.type === "success") {
    return {
      ...state,
      status: action.info === null ? "unavailable" : "ready",
      info: action.info,
      error: null,
    };
  }
  return {
    ...state,
    status: "error",
    info: null,
    error: action.error,
  };
}
