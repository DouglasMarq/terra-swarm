import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";

import styles from "./ui.module.css";

export type TooltipSide = "top" | "right" | "bottom" | "left";

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: TooltipSide;
  className?: string;
}

type DescribedElement = ReactElement<{ "aria-describedby"?: string; className?: string }>;

export function Tooltip({ children, className, content, side = "top" }: TooltipProps) {
  const id = useId();
  const describedBy = id.replace(/:/g, "");

  const child = isValidElement(children)
    ? cloneElement(children as DescribedElement, {
        "aria-describedby": [
          (children as DescribedElement).props["aria-describedby"],
          describedBy,
        ]
          .filter(Boolean)
          .join(" "),
      })
    : <span className={styles.tooltipTrigger}>{children}</span>;
  const classes = [styles.tooltip, className].filter(Boolean).join(" ");

  return (
    <span className={classes}>
      {child}
      <span className={styles.tooltipContent} data-side={side} id={describedBy} role="tooltip">
        {content}
      </span>
    </span>
  );
}
