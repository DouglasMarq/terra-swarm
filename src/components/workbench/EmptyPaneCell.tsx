import { useId } from "react";
import type { EmptyPaneCellProps } from "./types";

export function EmptyPaneCell({
  paneId,
  projectName,
  onNewTab,
  label = "Nenhum agente neste painel",
  description = "Crie um agente para começar neste painel.",
  actionLabel = "Criar agente neste painel",
  className,
}: EmptyPaneCellProps) {
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
        <h2 className="terra-empty-pane__title" id={titleId}>{label}</h2>
        <p className="terra-empty-pane__description" id={descriptionId}>{description}</p>
        {projectName ? (
          <p className="terra-empty-pane__context">Projeto: {projectName}</p>
        ) : null}
      </div>
      {onNewTab ? (
        <button type="button" className="terra-empty-pane__button" onClick={onNewTab}>
          {actionLabel}
        </button>
      ) : null}
    </section>
  );
}
