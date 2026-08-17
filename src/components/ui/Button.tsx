import { LoaderCircle } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import styles from "./ui.module.css";

export type ButtonVariant = "default" | "primary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    children,
    className,
    disabled,
    leadingIcon,
    loading = false,
    size = "md",
    trailingIcon,
    variant = "default",
    ...props
  },
  ref,
) {
  const classes = [styles.button, className].filter(Boolean).join(" ");

  return (
    <button
      {...props}
      ref={ref}
      className={classes}
      data-size={size}
      data-variant={variant}
      data-loading={loading || undefined}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
    >
      {loading ? <LoaderCircle aria-hidden="true" className={styles.spinner} size={14} /> : leadingIcon}
      <span className={styles.buttonContent}>{children}</span>
      {!loading && trailingIcon}
    </button>
  );
});

Button.displayName = "Button";
