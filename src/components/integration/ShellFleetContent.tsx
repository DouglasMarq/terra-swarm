import type { FleetBatchAction, FleetCommandCenterProps } from "../fleet/FleetCommandCenter";
import { FleetCommandCenter } from "./lazySurfaces";

export interface ShellFleetActions {
  onFocusTerminal: (terminalId: string) => void;
  onMarkRead: (terminalId: string) => void;
  onBatchStop: (ids: string[]) => void;
  onBatchResume: (ids: string[]) => void;
  onToggleVoice: () => void;
}

interface ShellFleetContentProps {
  view: Omit<FleetCommandCenterProps, "onFocus" | "onMarkRead" | "onBatchAction">;
  actions: ShellFleetActions;
}

function focusFirst(actions: ShellFleetActions, ids: readonly string[]): void {
  const [first] = ids;
  if (first) actions.onFocusTerminal(first);
}

function runFleetBatchAction(actions: ShellFleetActions, action: FleetBatchAction, ids: string[]): void {
  if (action === "stop") {
    actions.onBatchStop(ids);
    return;
  }
  if (action === "resume") {
    actions.onBatchResume(ids);
    return;
  }
  focusFirst(actions, ids);
  if (action === "voice") actions.onToggleVoice();
}

export function ShellFleetContent({ view, actions }: ShellFleetContentProps) {
  return (
    <FleetCommandCenter
      {...view}
      onFocus={(terminalId) => actions.onFocusTerminal(terminalId)}
      onMarkRead={actions.onMarkRead}
      onBatchAction={(action, ids) => runFleetBatchAction(actions, action, ids)}
    />
  );
}
