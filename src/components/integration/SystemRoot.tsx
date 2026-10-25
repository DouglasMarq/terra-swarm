import { useT } from "../../i18n";
import { lazy, Suspense, useState } from "react";

import { AppErrorBoundary, LoadingScreen } from "../system";

const LOADING_SURFACE_PROGRESS_PERCENT = 30;

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

