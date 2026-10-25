import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useT } from "../../i18n";
import { GRID_MAX, defaultGridDimensions, type GridDimensions } from "./layout";

export interface GridSizePickerProps {
  /** Dimensions currently in effect (automatic or fixed). */
  dimensions: GridDimensions;
  auto: boolean;
  paneCount: number;
  disabled?: boolean;
  onSelect: (dimensions: GridDimensions) => void;
  onAuto: () => void;
}

/** Above this many cells the picker warns that panes get small. */
const DENSE_GRID_CELLS = 16;

const CELLS = Array.from({ length: GRID_MAX * GRID_MAX }, (_cell, index) => ({
  column: (index % GRID_MAX) + 1,
  row: Math.floor(index / GRID_MAX) + 1,
}));

/**
 * "Grade" button with a popover: Automatic | Fixed and an 8×8 matrix you
 * hover to preview and click to fix. Automatic follows the pane count.
 */
export function GridSizePicker({ dimensions, auto, paneCount, disabled, onSelect, onAuto }: GridSizePickerProps) {
  const translate = useT();
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<GridDimensions | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const shown = hover ?? (auto ? defaultGridDimensions(paneCount) : dimensions);
  const strong = hover !== null || !auto;
  const total = shown.columns * shown.rows;
  const summary = auto && !hover
    ? translate("grid.autoSummary", { columns: shown.columns, rows: shown.rows, count: paneCount })
    : translate("grid.size", { columns: shown.columns, rows: shown.rows, count: total });
  let hint = translate("grid.hintAuto");
  if (hover || !auto) {
    if (total > DENSE_GRID_CELLS) hint = translate("grid.hintDense");
    else if (total > paneCount) hint = translate("grid.hintFill");
    else hint = translate("grid.hintOverflow");
  }
  const buttonLabel = auto ? translate("grid.label") : translate("grid.labelWithSize", { columns: dimensions.columns, rows: dimensions.rows });

  return (
    <div className="terra-grid-picker" ref={rootRef}>
      <button
        type="button"
        className="terra-grid-picker__trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={translate("grid.open")}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        {buttonLabel}
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open ? (
        <div className="terra-grid-picker__popover terra-anim-pop" role="dialog" aria-label={translate("grid.title")}>
          <div className="terra-segmented" role="group" aria-label={translate("grid.mode")}>
            <button type="button" aria-pressed={auto} data-active={auto} onClick={() => { setHover(null); onAuto(); }}>
              {translate("grid.auto")}
            </button>
            <button type="button" aria-pressed={!auto} data-active={!auto} onClick={() => { setHover(null); onSelect(dimensions); }}>
              {translate("grid.fixed")}
            </button>
          </div>
          <div className="terra-grid-picker__matrix" onMouseLeave={() => setHover(null)}>
            {CELLS.map(({ column, row }) => {
              const inside = column <= shown.columns && row <= shown.rows;
              return (
                <button
                  type="button"
                  key={`${column}x${row}`}
                  className="terra-grid-picker__cell"
                  data-inside={inside}
                  data-strong={inside && strong}
                  aria-label={translate("grid.cell", { columns: column, rows: row })}
                  onMouseEnter={() => setHover({ columns: column, rows: row })}
                  onFocus={() => setHover({ columns: column, rows: row })}
                  onClick={() => {
                    setHover(null);
                    onSelect({ columns: column, rows: row });
                  }}
                />
              );
            })}
          </div>
          <div className="terra-grid-picker__summary">
            <strong>{summary}</strong>
            <span>{hint}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
