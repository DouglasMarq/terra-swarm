import { useId } from "react";
import { useT } from "../../i18n";
import type { EmptyPaneCellProps } from "./types";

export function EmptyPaneCell({
  paneId,
  projectName,
  onNewTab,
  label,
  description,
  actionLabel,
  className,
}: EmptyPaneCellProps) {
  const t = useT();
  const id = useId();
  const classes = className ? `terra-empty-pane ${className}` : "terra-empty-pane";
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  return (
    <section
      className={classes}
      data-pane-id={paneId}
      role="status"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <div className="terra-empty-pane__content">
        <h2 className="terra-empty-pane__title" id={titleId}>{label ?? t("workbench.emptyPane")}</h2>
        <p className="terra-empty-pane__description" id={descriptionId}>{description ?? t("workbench.emptyPaneDescription")}</p>
        {projectName ? (
          <p className="terra-empty-pane__context">{t("workbench.emptyPaneProject", { name: projectName })}</p>
        ) : null}
      </div>
      {onNewTab ? (
        <button type="button" className="terra-empty-pane__button" onClick={onNewTab}>
          {actionLabel ?? t("workbench.emptyPaneAction")}
        </button>
      ) : null}
    </section>
  );
}
