import { lazy, Suspense, type ComponentProps } from "react";
import { useT } from "../../i18n";

const LazyFleetCommandCenter = lazy(async () => {
  const module = await import("../fleet/FleetCommandCenter");
  return { default: module.FleetCommandCenter };
});

const LazyWorkspaceWorkbench = lazy(async () => {
  const module = await import("../workbench/WorkspaceWorkbench");
  return { default: module.WorkspaceWorkbench };
});

export const LazyTerminalTabSurface = lazy(async () => {
  const module = await import("./TerminalTabSurface");
  return { default: module.TerminalTabSurface };
});

const LazyCommandPalette = lazy(async () => {
  const module = await import("../overlays/CommandPalette/CommandPalette");
  return { default: module.CommandPalette };
});

export function SurfaceLoading() {
  const t = useT();
  return (
    <div className="terra-surface-loading" role="status" aria-live="polite">
      {t("shell.loading")}
    </div>
  );
}

export function FleetCommandCenter(props: ComponentProps<typeof LazyFleetCommandCenter>) {
  return (
    <Suspense fallback={<SurfaceLoading />}>
      <LazyFleetCommandCenter {...props} />
    </Suspense>
  );
}

export function WorkspaceWorkbench(props: ComponentProps<typeof LazyWorkspaceWorkbench>) {
  return (
    <Suspense fallback={<SurfaceLoading />}>
      <LazyWorkspaceWorkbench {...props} />
    </Suspense>
  );
}

export function CommandPalette(props: ComponentProps<typeof LazyCommandPalette>) {
  if (!props.open) return null;
  return (
    <Suspense fallback={null}>
      <LazyCommandPalette {...props} />
    </Suspense>
  );
}
