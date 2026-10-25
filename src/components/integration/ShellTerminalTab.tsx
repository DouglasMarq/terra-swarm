import { Suspense } from "react";
import type { WorkbenchLocation, WorkbenchTabRenderContext } from "../workbench/types";
import type { TerminalTabSurfaceProps } from "./TerminalTabSurface";
import { LazyTerminalTabSurface, SurfaceLoading } from "./lazySurfaces";

export type ShellTerminalTabView = Pick<
  TerminalTabSurfaceProps,
  | "fontSize"
  | "focusedId"
  | "expandedId"
  | "exited"
  | "notifications"
  | "contextUsage"
  | "titles"
  | "worktreeBranches"
  | "roleLabels"
  | "detachedIds"
  | "labels"
  | "attentionMessages"
> & {
  branches: Readonly<Record<string, string>>;
};

export type ShellTerminalTabActions = Pick<
  TerminalTabSurfaceProps,
  "buildMenu" | "onClearNotifications" | "onToggleExpand" | "onRestart" | "onDetach" | "onKill" | "onOpenReview"
> & {
  onFocusTab: (id: string, location: WorkbenchLocation) => void;
};

interface ShellTerminalTabProps {
  context: WorkbenchTabRenderContext;
  view: ShellTerminalTabView;
  actions: ShellTerminalTabActions;
}

export function ShellTerminalTab({ context, view, actions }: ShellTerminalTabProps) {
  const { branches, ...surfaceView } = view;
  const { onFocusTab, ...surfaceActions } = actions;
  const project = context.project;
  const location: WorkbenchLocation = { containerId: context.container.id, paneId: context.pane.id, projectId: project?.id ?? null };
  return (
    <Suspense fallback={<SurfaceLoading />}>
      <LazyTerminalTabSurface
        context={context}
        {...surfaceView}
        {...surfaceActions}
        branch={project ? branches[project.id] : undefined}
        onFocus={(id) => onFocusTab(id, location)}
      />
    </Suspense>
  );
}
