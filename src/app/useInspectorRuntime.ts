import { useEffect, useReducer, useRef } from "react";
import { translateNow } from "../i18n";
import { errorMessage } from "../lib/errors/errorMessage";
import { ptyApi } from "../lib/tauri/pty";
import {
  INITIAL_INSPECTOR_RUNTIME_STATE,
  reduceInspectorRuntime,
  type InspectorRuntimeState,
} from "../components/inspector/inspectorRuntime";

export const INSPECTOR_RUNTIME_POLL_MS = 1500;

export function useInspectorRuntime(terminalId: string | null, isActive: boolean): InspectorRuntimeState {
  const [runtime, dispatch] = useReducer(reduceInspectorRuntime, INITIAL_INSPECTOR_RUNTIME_STATE);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    if (!isActive || !terminalId) {
      dispatch({ type: "reset", requestId });
      return;
    }

    let isCancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    dispatch({ type: "request", terminalId, requestId });

    const poll = async () => {
      try {
        const info = await ptyApi.terminalRuntimeInfo(terminalId);
        if (!isCancelled) dispatch({ type: "success", terminalId, requestId, info });
      } catch (error) {
        if (!isCancelled) {
          dispatch({ type: "failure", terminalId, requestId, error: errorMessage(error, translateNow("inspector.unavailable")) });
        }
      }
      if (!isCancelled) timer = setTimeout(() => void poll(), INSPECTOR_RUNTIME_POLL_MS);
    };

    void poll();
    return () => {
      isCancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [isActive, terminalId]);

  return runtime;
}
