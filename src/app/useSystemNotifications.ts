import { useEffect, useMemo, useRef } from "react";
import { ensureNotificationPermission, setAppBadgeCount, showNotification } from "../lib/tauri/notifications";
import { onAgentAttention, onTerminalNotification } from "../lib/tauri/pty";
import type { Workspace } from "../types";
import { t } from "../i18n";
import { agentLabelText, buildAgentLabels } from "../domain/agentLabels";
import { deriveAgentStatus } from "../domain/agentStatus";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useReportedStates } from "../stores/mcpStore";
import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";

/** One native notification per agent at most this often. */
const PER_AGENT_COOLDOWN_MS = 30_000;

/** Whether a native notification should be shown for this agent now. */
export function shouldNotify(
  lastShown: Map<string, number>,
  terminalId: string,
  now: number,
  appFocused: boolean,
): boolean {
  if (appFocused) return false;
  const last = lastShown.get(terminalId);
  if (last !== undefined && now - last < PER_AGENT_COOLDOWN_MS) return false;
  lastShown.set(terminalId, now);
  return true;
}

/**
 * Native notifications when an agent needs a human while the app is in the
 * background, and the number of such agents on the app icon.
 */
export function useSystemNotifications(workspaces: readonly Workspace[]) {
  const enabled = usePreferencesStore((state) => state.systemNotifications);
  const exited = useTerminalRuntimeStore((state) => state.exited);
  const notifications = useTerminalRuntimeStore((state) => state.notifications);
  const contextUsage = useTerminalRuntimeStore((state) => state.contextUsage);
  const reported = useReportedStates();
  const lastShown = useRef(new Map<string, number>());
  const latest = useRef({ workspaces, enabled });
  latest.current = { workspaces, enabled };

  const waiting = useMemo(
    () =>
      workspaces
        .flatMap((workspace) => workspace.terminals)
        .filter(
          (terminal) =>
            deriveAgentStatus({
              suspended: terminal.suspended,
              exited: terminal.id in exited,
              notifications: notifications[terminal.id],
              contextUsed: contextUsage[terminal.id],
              reported: reported[terminal.id],
            }) === "attention",
        ).length,
    [workspaces, exited, notifications, contextUsage, reported],
  );

  useEffect(() => {
    const count = enabled && waiting > 0 ? waiting : undefined;
    setAppBadgeCount(count)
      .catch((error) => console.warn("could not set the app badge:", error));
  }, [enabled, waiting]);

  useEffect(() => {
    const show = async (terminalId: string, body: string) => {
      const { workspaces: current, enabled: on } = latest.current;
      if (!on || !shouldNotify(lastShown.current, terminalId, Date.now(), document.hasFocus())) return;
      if (!(await ensureNotificationPermission())) return;
      const labels = buildAgentLabels(current as Workspace[], {
        titles: useTerminalRuntimeStore.getState().titles,
        names: usePreferencesStore.getState().agentNames,
      });
      const label = labels[terminalId];
      showNotification({
        title: t("notifications.needsYouTitle", { name: label ? agentLabelText(label) : terminalId }),
        body: body || t("notifications.needsYouBody"),
      });
    };
    const pending = [
      onAgentAttention((payload) => {
        void show(payload.terminal_id, payload.message ?? "");
      }),
      onTerminalNotification((payload) => {
        void show(payload.id, payload.messages[0] ?? "");
      }),
    ];
    return () => {
      for (const unlisten of pending) void unlisten.then((stop) => stop());
    };
  }, []);
}
