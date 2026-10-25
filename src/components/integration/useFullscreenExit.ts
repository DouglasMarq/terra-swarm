import { useEffect, useMemo } from "react";
import type { WorkspaceSnapshotV2 } from "../../domain/workspace.model";

type SetContainerFullscreen = (containerId: string, fullscreen: boolean) => void;

interface FullscreenExitOptions {
  snapshot: WorkspaceSnapshotV2 | null;
  dockOpen: boolean;
  setContainerFullscreen: SetContainerFullscreen;
}

const ESCAPE_IGNORED_TARGETS = ".xterm, [role='dialog'], [role='menu']";

function useLeaveFullscreenWhenDockOpens(dockOpen: boolean, fullscreenIds: readonly string[], setContainerFullscreen: SetContainerFullscreen) {
  useEffect(() => {
    if (dockOpen) fullscreenIds.forEach((id) => setContainerFullscreen(id, false));
  }, [dockOpen]);
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

export function useFullscreenExit({ snapshot, dockOpen, setContainerFullscreen }: FullscreenExitOptions) {
  const fullscreenIds = useMemo(
    () => (snapshot?.containers ?? []).filter((container) => container.fullscreen).map((container) => container.id),
    [snapshot],
  );
  useLeaveFullscreenWhenDockOpens(dockOpen, fullscreenIds, setContainerFullscreen);
  useLeaveFullscreenOnEscape(fullscreenIds, setContainerFullscreen);
}
