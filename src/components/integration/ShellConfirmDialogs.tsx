import { useT } from "../../i18n";
import type { CommandConfirmRequest, FocusedAgentAction } from "../overlays/CommandPalette";
import { ConfirmActionDialog } from "../overlays/Dialog";
import type { InspectorTarget } from "../inspector/inspectorModel";

export interface PendingInspectorAction {
  action: "restart" | "kill";
  target: InspectorTarget;
}

interface ShellConfirmDialogsProps {
  commandRequest: CommandConfirmRequest | null;
  onCommandRequestChange: (request: CommandConfirmRequest | null) => void;
  inspectorRequest: PendingInspectorAction | null;
  onInspectorRequestChange: (request: PendingInspectorAction | null) => void;
  onImportWorkspace?: () => void;
  onFocusedAgentAction?: (action: FocusedAgentAction, context: { workspaceId: string; terminalId: string; command: string }) => void;
  onKill: (id: string) => void;
  onRestart: (id: string, command: string) => void;
}

export function ShellConfirmDialogs(props: ShellConfirmDialogsProps) {
  const t = useT();
  const pendingCommandConfirmation = props.commandRequest;
  const pendingInspectorAction = props.inspectorRequest;
  return <>
    <ConfirmActionDialog
      open={pendingCommandConfirmation !== null}
      onOpenChange={(open) => {
        if (!open) props.onCommandRequestChange(null);
      }}
      title={pendingCommandConfirmation?.title}
      description={pendingCommandConfirmation ? t("dialogs.resourceDescription", { resource: pendingCommandConfirmation.resourceLabel, description: pendingCommandConfirmation.description }) : ""}
      intent={pendingCommandConfirmation?.kind === "stop-agent" ? "destructive" : "default"}
      confirmLabel={pendingCommandConfirmation?.kind === "import-snapshot" ? t("system.continueImport") : pendingCommandConfirmation?.kind === "stop-agent" ? t("pane.confirmKill.confirm") : t("dialogs.confirmTitle")}
      onConfirm={() => {
        const request = pendingCommandConfirmation;
        if (!request) return;
        props.onCommandRequestChange(null);
        if (request.kind === "import-snapshot") {
          props.onImportWorkspace?.();
          return;
        }
        if (request.action && request.workspaceId && request.terminalId) {
          props.onFocusedAgentAction?.(request.action, {
            workspaceId: request.workspaceId,
            terminalId: request.terminalId,
            command: request.resourceLabel,
          });
        }
      }}
    />
    <ConfirmActionDialog
      open={pendingInspectorAction !== null}
      onOpenChange={(open) => {
        if (!open) props.onInspectorRequestChange(null);
      }}
      title={pendingInspectorAction?.action === "kill" ? t("pane.confirmKill.confirm") : t("system.restartSession")}
      description={pendingInspectorAction
        ? `${pendingInspectorAction.target.displayName} · ${pendingInspectorAction.target.command}`
        : ""}
      intent={pendingInspectorAction?.action === "kill" ? "destructive" : "default"}
      confirmLabel={pendingInspectorAction?.action === "kill" ? t("pane.confirmKill.confirm") : t("system.restartSession")}
      onConfirm={() => {
        const request = pendingInspectorAction;
        if (!request) return;
        props.onInspectorRequestChange(null);
        if (request.action === "kill") props.onKill(request.target.terminalId);
        else props.onRestart(request.target.terminalId, request.target.command);
      }}
    />
  </>;
}
