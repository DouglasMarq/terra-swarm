import type { HTMLAttributes } from "react";

import styles from "./ui.module.css";

export type Status = "running" | "attention" | "error" | "offline";
export type StatusDotSize = "sm" | "md" | "lg";

export interface StatusDotProps extends HTMLAttributes<HTMLSpanElement> {
  status?: Status;
  size?: StatusDotSize;
  pulse?: boolean;
  label?: string;
}

export function StatusDot({
  className,
  label,
  pulse = false,
  size = "md",
  status = "offline",
  ...props
}: StatusDotProps) {
  const classes = [styles.statusDot, className].filter(Boolean).join(" ");
  // Keep the regular HTML aria-label escape hatch working alongside the
  // component's shorter `label` prop.  Previously the spread props were
  // overwritten by `aria-label={label}`, so a caller using the standard
  // attribute silently lost its accessible name.
  const accessibleLabel = label ?? props["aria-label"];
  const role = accessibleLabel ? (props.role ?? "img") : props.role;
  const ariaHidden = accessibleLabel ? undefined : (props["aria-hidden"] ?? true);

  return (
    <span
      {...props}
      className={classes}
      data-pulse={pulse || undefined}
      data-size={size}
      data-status={status}
      role={role}
      aria-label={accessibleLabel}
      aria-hidden={ariaHidden}
    />
  );
}
