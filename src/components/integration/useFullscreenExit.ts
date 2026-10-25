import { useEffect, useEffectEvent, useMemo } from "react";
import type { WorkspaceSnapshotV2 } from "../../domain/workspace.model";

type SetContainerFullscreen = (containerId: string, isFullscreen: boolean) => void;

interface FullscreenExitOptions {
  snapshot: WorkspaceSnapshotV2 | null;
  isDockOpen: boolean;
  setContainerFullscreen: SetContainerFullscreen;
}

const ESCAPE_IGNORED_TARGETS = ".xterm, [role='dialog'], [role='menu']";

function useLeaveFullscreenWhenDockOpens(isDockOpen: boolean, fullscreenIds: readonly string[], setContainerFullscreen: SetContainerFullscreen) {
  const leaveFullscreen = useEffectEvent(() => fullscreenIds.forEach((id) => setContainerFullscreen(id, false)));
  useEffect(() => {
    if (isDockOpen) leaveFullscreen();
  }, [isDockOpen]);
}

function useLeaveFullscreenOnEscape(fullscreenIds: readonly string[], setContainerFullscreen: SetContainerFullscreen) {
  useEffect(() => {
    if (fullscreenIds.length === 0) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Moved as-is from VisualShellSurface; keydown targets are elements in practice.
      const target = event.target as HTMLElement | null;
      if (target?.closest(ESCAPE_IGNORED_TARGETS)) return;
      fullscreenIds.forEach((id) => setContainerFullscreen(id, false));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullscreenIds, setContainerFullscreen]);
}

export function useFullscreenExit({ snapshot, isDockOpen, setContainerFullscreen }: FullscreenExitOptions) {
  const fullscreenIds = useMemo(
    () => (snapshot?.containers ?? []).filter((container) => container.fullscreen).map((container) => container.id),
    [snapshot],
  );
  useLeaveFullscreenWhenDockOpens(isDockOpen, fullscreenIds, setContainerFullscreen);
  useLeaveFullscreenOnEscape(fullscreenIds, setContainerFullscreen);
}
