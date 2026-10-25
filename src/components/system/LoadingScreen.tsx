import { useT, type MessageKey } from "../../i18n";
import { CheckCircle2, LoaderCircle, Orbit } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { clamp } from "../../lib/math/clamp";

import styles from "./system.module.css";

export type LoadingScreenPhase = "booting" | "hydrating" | "connecting" | "ready";

export interface LoadingScreenProps {
  status?: ReactNode;
  progress?: number;
  title?: ReactNode;
  subtitle?: ReactNode;
  phase?: LoadingScreenPhase;
  className?: string;
}

const PHASE_LABELS: Record<LoadingScreenPhase, MessageKey> = {
  booting: "system.booting",
  hydrating: "system.hydrating",
  connecting: "system.connecting",
  ready: "system.ready",
};

const MIN_PROGRESS = 0;
const MAX_PROGRESS = 100;

function clampProgress(progress: number) {
  return clamp(progress, MIN_PROGRESS, MAX_PROGRESS);
}

export function LoadingScreen({
  className,
  phase = "booting",
  progress,
  status,
  subtitle,
  title,
}: LoadingScreenProps) {
  const translate = useT();
  const progressValue = progress === undefined ? undefined : clampProgress(progress);
  const rootClassName = [styles.loadingScreen, className].filter(Boolean).join(" ");
  const progressStyle = (
    progressValue === undefined ? undefined : { width: `${progressValue}%` }
  ) as CSSProperties | undefined;

  return (
    <main className={rootClassName} aria-busy={phase !== "ready"}>
      <section className={styles.loadingPanel} aria-label={translate("system.startup")}>
        <div className={styles.loadingMark} aria-hidden="true">
          <Orbit />
        </div>
        <div className={styles.loadingCopy}>
          <p className={styles.loadingKicker}>terra / swarm</p>
          <h1 className={styles.loadingTitle}>{title ?? translate("common.appName")}</h1>
          <p className={styles.loadingSubtitle}>{subtitle ?? translate("system.subtitle")}</p>
        </div>
        <div className={styles.loadingStatus} role="status" aria-live="polite">
          {phase === "ready" ? (
            <CheckCircle2 className={styles.loadingReadyIcon} size={13} aria-hidden="true" />
          ) : (
            <LoaderCircle className={styles.loadingSpinner} size={13} aria-hidden="true" />
          )}
          <span>{status ?? translate(PHASE_LABELS[phase])}</span>
        </div>
        {progressValue === undefined ? null : (
          <div
            className={styles.loadingProgress}
            role="progressbar"
            aria-label={translate("system.progress")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progressValue}
          >
            <div className={styles.loadingProgressValue} style={progressStyle} />
          </div>
        )}
      </section>
    </main>
  );
}
