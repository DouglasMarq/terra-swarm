import type { HTMLAttributes, ReactNode } from "react";

import type { Status } from "./StatusDot";
import { StatusDot } from "./StatusDot";
import styles from "./ui.module.css";

export type BadgeTone = "neutral" | "running" | "attention" | "error" | "agent";
export type BadgeSize = "sm" | "md";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  size?: BadgeSize;
  shape?: "rounded" | "pill";
  indicator?: Status;
  children?: ReactNode;
}

export function Badge({
  children,
  className,
  indicator,
  shape = "rounded",
  size = "md",
  tone = "neutral",
  ...props
}: BadgeProps) {
  const classes = [styles.badge, className].filter(Boolean).join(" ");

  return (
    <span {...props} className={classes} data-shape={shape} data-size={size} data-tone={tone}>
      {indicator ? <StatusDot aria-hidden="true" size="sm" status={indicator} /> : null}
      {children}
    </span>
  );
}
