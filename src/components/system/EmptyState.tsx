import { Layers3 } from "lucide-react";
import type { ReactNode } from "react";

import styles from "./system.module.css";

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  eyebrow?: ReactNode;
  compact?: boolean;
  className?: string;
}

export function EmptyState({
  action,
  className,
  compact = false,
  description,
  eyebrow,
  icon,
  title,
}: EmptyStateProps) {
  const rootClassName = [styles.emptyState, className].filter(Boolean).join(" ");

  return (
    <section className={rootClassName} data-compact={compact || undefined} aria-live="polite">
      <span className={styles.emptyIcon} aria-hidden="true">
        {icon ?? <Layers3 size={19} strokeWidth={1.7} />}
      </span>
      {eyebrow ? <p className={styles.emptyEyebrow}>{eyebrow}</p> : null}
      <h2 className={styles.emptyTitle}>{title}</h2>
      {description ? <p className={styles.emptyDescription}>{description}</p> : null}
      {action ? <div className={styles.emptyAction}>{action}</div> : null}
    </section>
  );
}
