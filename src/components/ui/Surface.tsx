import { createElement, type HTMLAttributes, type ReactNode } from "react";

import styles from "./ui.module.css";

export type SurfaceTone = "base" | "chrome" | "panel" | "elevated" | "terminal";
export type SurfacePadding = "none" | "sm" | "md" | "lg";
export type SurfaceElement = "div" | "section" | "article" | "aside" | "main" | "nav";

export interface SurfaceProps extends HTMLAttributes<HTMLElement> {
  as?: SurfaceElement;
  tone?: SurfaceTone;
  padding?: SurfacePadding;
  bordered?: boolean;
  interactive?: boolean;
  children?: ReactNode;
}

export function Surface({
  as = "div",
  bordered = false,
  children,
  className,
  interactive = false,
  padding = "none",
  tone = "panel",
  ...props
}: SurfaceProps) {
  const classes = [styles.surface, className].filter(Boolean).join(" ");

  return createElement(
    as,
    {
      ...props,
      className: classes,
      "data-bordered": bordered || undefined,
      "data-interactive": interactive || undefined,
      "data-padding": padding,
      "data-tone": tone,
    },
    children,
  );
}
