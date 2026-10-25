import { useT } from "../../i18n";
import { lazy, Suspense, useState } from "react";

import { AppErrorBoundary, LoadingScreen } from "../system";

/** Progress shown while the app bundle loads: the shell is up, the workspace is not. */
const LOADING_SURFACE_PROGRESS_PERCENT = 30;

/**
 * Creates a fresh lazy boundary for each recovery attempt. This matters for
 * transient bootstrap failures: React caches a rejected `lazy` import, so
 * merely clearing the error boundary would otherwise render the same failure
 * forever.
 */
function LazyApp() {
  const translate = useT();
  const [App] = useState(() => lazy(() => import("../../App")));

  return (
    <Suspense
      fallback={
        <LoadingScreen
          phase="booting"
          progress={LOADING_SURFACE_PROGRESS_PERCENT}
          status={translate("system.loadingSurface")}
        />
      }
    >
      <App />
    </Suspense>
  );
}

/**
 * System-level host for the product surface. App owns product state and
 * interactions; this layer owns only boot/recovery concerns.
 */
export function SystemRoot() {
  const [attempt, setAttempt] = useState(0);

  return (
    <AppErrorBoundary
      resetKeys={[attempt]}
      onReset={() => setAttempt((current) => current + 1)}
    >
      <LazyApp key={attempt} />
    </AppErrorBoundary>
  );
}

