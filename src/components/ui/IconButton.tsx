import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import styles from "./ui.module.css";

export type IconButtonVariant = "ghost" | "solid" | "danger";
export type IconButtonSize = "sm" | "md" | "lg";

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode;
  label: string;
  size?: IconButtonSize;
  variant?: IconButtonVariant;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, icon, label, size = "md", variant = "ghost", ...props },
  ref,
) {
  const classes = [styles.iconButton, className].filter(Boolean).join(" ");

  return (
    <button
      {...props}
      ref={ref}
      type={props.type ?? "button"}
      className={classes}
      data-size={size}
      data-variant={variant}
      aria-label={label}
    >
      {icon}
    </button>
  );
});

IconButton.displayName = "IconButton";
