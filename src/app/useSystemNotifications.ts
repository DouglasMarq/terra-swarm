import { useEffect, useMemo, useRef } from "react";
import { ensureNotificationPermission, setAppBadgeCount, showNotification } from "../lib/tauri/notifications";
import { onAgentAttention, onTerminalNotification } from "../lib/tauri/pty";
import type { Workspace } from "../domain/workspace.model";
import { translateNow } from "../i18n";
import { agentLabelText, buildAgentLabels } from "../domain/agentLabels";
import { deriveAgentStatus } from "../domain/agentStatus";
import { shouldNotify } from "../domain/notifications";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useReportedStates } from "../stores/mcpStore";
import { useTerminalRuntimeStore } from "../stores/terminalRuntimeStore";

export function useSystemNotifications(workspaces: readonly Workspace[]) {
  const isEnabled = usePreferencesStore((state) => state.isSystemNotificationsEnabled);
  const exited = useTerminalRuntimeStore((state) => state.exited);
  const notifications = useTerminalRuntimeStore((state) => state.notifications);
  const contextUsage = useTerminalRuntimeStore((state) => state.contextUsage);
  const reported = useReportedStates();
  const lastShown = useRef(new Map<string, number>());
  const latest = useRef({ workspaces, isEnabled });
  latest.current = { workspaces, isEnabled };

  const waiting = useMemo(
    () =>
      workspaces
        .flatMap((workspace) => workspace.terminals)
        .filter(
          (terminal) =>
            deriveAgentStatus({
              isSuspended: terminal.suspended,
              hasExited: terminal.id in exited,
              notifications: notifications[terminal.id],
              contextUsed: contextUsage[terminal.id],
              reported: reported[terminal.id],
            }) === "attention",
        ).length,
    [workspaces, exited, notifications, contextUsage, reported],
  );

  useEffect(() => {
    const count = isEnabled && waiting > 0 ? waiting : undefined;
    setAppBadgeCount(count)
      .catch((error) => console.warn("could not set the app badge:", error));
  }, [isEnabled, waiting]);

  useEffect(() => {
    const show = async (terminalId: string, body: string) => {
      const { workspaces: current, isEnabled: isEnabledNow } = latest.current;
      if (!isEnabledNow || !shouldNotify(lastShown.current, terminalId, { now: Date.now(), isAppFocused: document.hasFocus() })) return;
      if (!(await ensureNotificationPermission())) return;
      const labels = buildAgentLabels(current as Workspace[], {
        titles: useTerminalRuntimeStore.getState().titles,
        names: usePreferencesStore.getState().agentNames,
      });
      const label = labels[terminalId];
      showNotification({
        title: translateNow("notifications.needsYouTitle", { name: label ? agentLabelText(label) : terminalId }),
        body: body || translateNow("notifications.needsYouBody"),
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
