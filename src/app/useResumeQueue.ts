import { useEffect, useEffectEvent, useRef, useState } from "react";
import { api } from "../api";
import type { ResumeItem } from "../domain/terminal.model";
import { translateNow } from "../i18n";
import { errorMessage } from "../lib/errors/errorMessage";
import { dismissResumeItems } from "../domain/session/resumeDismiss";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";
import type { TerminalSessions } from "./useTerminalSessions";

export type ResumeSessions = Pick<TerminalSessions, "resumeItem" | "forget" | "resumeItems" | "notifyResumeFailures">;

export function useResumeQueue(sessions: ResumeSessions, refresh: () => Promise<void>) {
  const items = useTerminalRuntimeStore((state) => state.resumeItems);
  const [isVisible, setVisible] = useState(false);
  const [isAutoPending, setAutoPending] = useState(false);
  const mutating = useRef(false);
  const resuming = useRef<Set<string>>(new Set());
  const runtime = () => useTerminalRuntimeStore.getState();

  const offer = (found: ResumeItem[]) => {
    runtime().setResumeItems(found);
    if (usePreferencesStore.getState().shouldAutoResume) setAutoPending(true);
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
      runtime().pushSystemNotification(translateNow("app.resumeFailed", { name: item.wsName, detail: errorMessage(error) }));
    } finally {
      resuming.current.delete(item.terminalId);
      mutating.current = false;
    }
    await refresh();
  };

  const forgetDismissed = (item: ResumeItem) => {
    sessions.forget([item.terminalId]);
    usePreferencesStore.getState().setAgentName(item.terminalId, null);
  };

  const dismissOne = async (item: ResumeItem) => {
    if (mutating.current) return;
    mutating.current = true;
    try {
      const [result] = await dismissResumeItems([item], (candidate) => api.killTerminal(candidate.terminalId));
      if (result?.status === "failed") {
        console.error(`failed to dismiss resume item ${item.terminalId}:`, result.error);
        runtime().pushSystemNotification(translateNow("app.dismissFailed", { name: item.wsName, detail: errorMessage(result.error) }));
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
          runtime().pushSystemNotification(translateNow("app.dismissFailed", { name: result.item.wsName, detail: errorMessage(result.error) }));
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

  const autoResume = useEffectEvent(() => {
    void resumeAll();
  });

  useEffect(() => {
    if (!isAutoPending || !items || items.length === 0) return;
    setAutoPending(false);
    autoResume();
  }, [isAutoPending, items]);

  return {
    items,
    isOpen: isVisible && items !== null && items.length > 0,
    show: () => setVisible(true),
    defer: () => setVisible(false),
    offer,
    resumeOne,
    dismissOne,
    resumeAll,
    dismissAll,
  };
}
