import { useEffect, useReducer, useRef } from "react";
import { t } from "../i18n";
import { errorMessage } from "../lib/errors/errorMessage";
import { ptyApi } from "../lib/tauri/pty";
import {
  INITIAL_INSPECTOR_RUNTIME_STATE,
  reduceInspectorRuntime,
  type InspectorRuntimeState,
} from "../components/inspector/inspectorRuntime";

/** How often the inspector refreshes the focused agent's runtime info. */
export const INSPECTOR_RUNTIME_POLL_MS = 1500;

/**
 * Poll the runtime info of `terminalId` while the inspector shows it; stops
 * as soon as the inspector closes or the focus moves, and ignores late answers.
 */
export function useInspectorRuntime(terminalId: string | null, active: boolean): InspectorRuntimeState {
  const [runtime, dispatch] = useReducer(reduceInspectorRuntime, INITIAL_INSPECTOR_RUNTIME_STATE);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    if (!active || !terminalId) {
      dispatch({ type: "reset", requestId });
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    dispatch({ type: "request", terminalId, requestId });

    const poll = async () => {
      try {
        const info = await ptyApi.terminalRuntimeInfo(terminalId);
        if (!cancelled) dispatch({ type: "success", terminalId, requestId, info });
      } catch (error) {
        if (!cancelled) {
          dispatch({ type: "failure", terminalId, requestId, error: errorMessage(error, t("inspector.unavailable")) });
        }
      }
      if (!cancelled) timer = setTimeout(() => void poll(), INSPECTOR_RUNTIME_POLL_MS);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [active, terminalId]);

  return runtime;
}
