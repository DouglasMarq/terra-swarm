import { useEffect, useEffectEvent, useRef, useState } from "react";
import { api } from "../api";
import type { ResumeItem } from "../domain/terminal.model";
import { t } from "../i18n";
import { errorMessage } from "../lib/errors/errorMessage";
import { dismissResumeItems } from "../domain/session/resumeDismiss";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";
import type { TerminalSessions } from "./useTerminalSessions";

/**
 * Sessions that were running when the app last closed: offered on the
 * opening screen (or resumed right away when the user chose that), resumed
 * or discarded one at a time or all together.
 */
export function useResumeQueue(sessions: TerminalSessions, refresh: () => Promise<void>) {
  const items = useTerminalRuntimeStore((state) => state.resumeItems);
  const [visible, setVisible] = useState(false);
  const [autoPending, setAutoPending] = useState(false);
  // One queue mutation at a time; a single item is never resumed twice.
  const mutating = useRef(false);
  const resuming = useRef<Set<string>>(new Set());
  const runtime = () => useTerminalRuntimeStore.getState();

  /** Offer sessions found at startup. */
  const offer = (found: ResumeItem[]) => {
    runtime().setResumeItems(found);
    if (usePreferencesStore.getState().autoResume) setAutoPending(true);
    else setVisible(true);
    api.storeSavedAt()
      .then(runtime().setResumeSavedAt)
      .catch((error) => console.warn("could not read when the workspaces were saved:", error));
  };

  const resumeOne = async (item: ResumeItem) => {
    if (mutating.current || resuming.current.has(item.terminalId)) return;
    mutating.current = true;
    resuming.current.add(item.terminalId);
    try {
      await sessions.resumeItem(item);
      runtime().dropResumeItem(item.terminalId);
    } catch (error) {
      runtime().pushSystemNotification(t("app.resumeFailed", { name: item.wsName, detail: errorMessage(error) }));
    } finally {
      resuming.current.delete(item.terminalId);
      mutating.current = false;
    }
    await refresh();
  };

  /** Forget a discarded session locally once the backend deleted it. */
  const forgetDismissed = (item: ResumeItem) => {
    sessions.forget([item.terminalId]);
    usePreferencesStore.getState().setAgentName(item.terminalId, null);
  };

  const dismissOne = async (item: ResumeItem) => {
    if (mutating.current) return;
    mutating.current = true;
    try {
      // Clear local ownership only after the backend confirms the deletion:
      // a rejected kill leaves the item retryable and the refs intact.
      const [result] = await dismissResumeItems([item], (candidate) => api.killTerminal(candidate.terminalId));
      if (result?.status === "failed") {
        console.error(`failed to dismiss resume item ${item.terminalId}:`, result.error);
        runtime().pushSystemNotification(t("app.dismissFailed", { name: item.wsName, detail: errorMessage(result.error) }));
        return;
      }
      forgetDismissed(item);
      runtime().dropResumeItem(item.terminalId);
      await refresh();
    } finally {
      mutating.current = false;
    }
  };

  const resumeAll = async () => {
    const queued = runtime().resumeItems ?? [];
    if (queued.length === 0 || mutating.current) return;
    mutating.current = true;
    try {
      // Close the dialog while the queue owns these terminal ids; failed
      // items come back below for an explicit retry.
      runtime().setResumeItems(null);
      const results = await sessions.resumeItems(queued);
      sessions.notifyResumeFailures(results, new Map(queued.map((item) => [item.terminalId, item.wsName])));
      const failed = new Set(results.filter((result) => result.status !== "succeeded").map((result) => result.id));
      runtime().setResumeItems(failed.size > 0 ? queued.filter((item) => failed.has(item.terminalId)) : null);
      await refresh();
    } finally {
      mutating.current = false;
    }
  };

  const dismissAll = async () => {
    const queued = runtime().resumeItems ?? [];
    if (queued.length === 0 || mutating.current) return;
    mutating.current = true;
    try {
      const results = await dismissResumeItems(queued, (item) => api.killTerminal(item.terminalId));
      const failed: ResumeItem[] = [];
      for (const result of results) {
        if (result.status === "failed") {
          failed.push(result.item);
          console.error(`failed to dismiss resume item ${result.item.terminalId}:`, result.error);
          runtime().pushSystemNotification(t("app.dismissFailed", { name: result.item.wsName, detail: errorMessage(result.error) }));
          continue;
        }
        forgetDismissed(result.item);
      }
      runtime().setResumeItems(failed.length > 0 ? failed : null);
      await refresh();
    } finally {
      mutating.current = false;
    }
  };

  // "Always resume without asking": run the queue once it is loaded.
  const autoResume = useEffectEvent(() => {
    void resumeAll();
  });

  useEffect(() => {
    if (!autoPending || !items || items.length === 0) return;
    setAutoPending(false);
    autoResume();
    // Keyed on the queue loading only: resumeAll changes every render and reads the latest state itself.
  }, [autoPending, items]);

  return {
    items,
    /** The opening screen is showing. */
    open: visible && items !== null && items.length > 0,
    show: () => setVisible(true),
    defer: () => setVisible(false),
    offer,
    resumeOne,
    dismissOne,
    resumeAll,
    dismissAll,
  };
}
