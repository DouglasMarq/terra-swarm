// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutMode, WorkspaceLayout } from "../../domain/workspace.model";
import { useLocaleStore } from "../../i18n";
import { PaneGrid } from "./PaneGrid";
import type { WorkbenchContainerProjection, WorkbenchLayoutMode } from "./types";

function projection(paneIds: readonly string[], layout: Partial<WorkspaceLayout> = {}): WorkbenchContainerProjection {
  return {
    container: {
      id: "container-1",
      projectId: "project-1",
      paneIds: [...paneIds],
      layout: { mode: "auto" as LayoutMode, itemIds: [...paneIds], ...layout },
      isVisible: true,
      isCollapsed: false,
      isClosed: false,
      isFullscreen: false,
    },
    project: null,
    group: null,
    panes: paneIds.map((id) => ({
      pane: { id, projectId: "project-1", containerId: "container-1", tabIds: [], activeTabId: null, layout: { mode: "auto" } },
      tabs: [],
    })),
  };
}

function renderGrid(paneIds: readonly string[], options: { layout?: Partial<WorkspaceLayout>; mode?: WorkbenchLayoutMode; activePaneId?: string | null } = {}) {
  const onLayoutChange = vi.fn();
  const view = render(
    <PaneGrid
      projection={projection(paneIds, options.layout)}
      mode={options.mode}
      activePaneId={options.activePaneId}
      onLayoutChange={onLayoutChange}
      renderPane={({ pane }) => <div>Pane {pane.id}</div>}
    />,
  );
  return { onLayoutChange, view };
}

function cellOf(paneId: string): HTMLElement {
  const cell = screen.getByText(`Pane ${paneId}`).parentElement;
  if (!cell) throw new Error(`pane ${paneId} has no cell`);
  return cell;
}

beforeEach(() => {
  useLocaleStore.setState({ locale: "en" });
});

const GROUP_WIDTH_PX = 1000;
const GROUP_HEIGHT_PX = 600;

function withMeasuredLayout() {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(GROUP_WIDTH_PX);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(GROUP_HEIGHT_PX);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ width: GROUP_WIDTH_PX, height: GROUP_HEIGHT_PX }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
}

function flexGrowOf(paneId: string): number {
  const panel = document.getElementById(paneId);
  return Number.parseFloat(panel?.style.flexGrow ?? "NaN");
}

describe("PaneGrid", () => {
  it("Given no panes, when it renders, then nothing is drawn", () => {
    const { view } = renderGrid([]);

    expect(view.container).toBeEmptyDOMElement();
  });

  it("Given spotlight with several panes, when it renders, then the active pane fills the left column and the rest stack on the right", () => {
    renderGrid(["a", "b", "c"], { mode: "spotlight", activePaneId: "b" });

    const grid = document.querySelector('[data-layout-mode="spotlight"]');
    expect(grid).toHaveStyle({ gridTemplateColumns: "minmax(0, 72fr) minmax(0, 28fr)", gridTemplateRows: "repeat(2, minmax(0, 1fr))" });
    expect(grid).not.toHaveAttribute("data-grid-columns");
    expect(cellOf("b")).toHaveStyle({ gridColumn: "1", gridRow: "1 / -1" });
    expect(cellOf("a")).toHaveStyle({ gridColumn: "2", gridRow: "1" });
    expect(cellOf("c")).toHaveStyle({ gridColumn: "2", gridRow: "2" });
  });

  it("Given spotlight with an unknown active pane, when it renders, then the first pane takes the spotlight", () => {
    renderGrid(["a", "b"], { layout: { mode: "spotlight" }, activePaneId: "gone" });

    expect(cellOf("a")).toHaveStyle({ gridColumn: "1", gridRow: "1 / -1" });
    expect(cellOf("b")).toHaveStyle({ gridColumn: "2", gridRow: "1" });
  });

  it("Given spotlight with one pane, when it renders, then it takes the whole grid", () => {
    renderGrid(["a"], { mode: "spotlight", activePaneId: "a" });

    expect(document.querySelector('[data-layout-mode="spotlight"]')).toHaveStyle({
      gridTemplateColumns: "minmax(0, 1fr)",
      gridTemplateRows: "repeat(1, minmax(0, 1fr))",
    });
  });

  it("Given a grid whose last row is not full, when it renders, then the last row's panes stretch to fill it", () => {
    renderGrid(["a", "b", "c", "d", "e"], { layout: { mode: "grid", columns: 3, rows: 2 } });

    const grid = document.querySelector('[data-layout-mode="grid"]');
    expect(grid).toHaveAttribute("data-grid-columns", "3");
    expect(grid).toHaveStyle({ gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gridTemplateRows: "repeat(2, minmax(0, 1fr))" });
    expect(cellOf("a")).toHaveStyle({ gridColumn: "span 2" });
    expect(cellOf("c")).toHaveStyle({ gridColumn: "span 2" });
    expect(cellOf("d")).toHaveStyle({ gridColumn: "span 3" });
    expect(cellOf("e")).toHaveStyle({ gridColumn: "span 3" });
  });

  it("Given a full grid, when it renders, then panes need no explicit placement", () => {
    renderGrid(["a", "b", "c", "d"], { layout: { mode: "grid", columns: 2 } });

    expect(cellOf("a").style.gridColumn).toBe("");
    expect(cellOf("d").style.gridColumn).toBe("");
  });

  it("Given a persisted pane order and sizes, when splitting horizontally, then panes follow it with a separator between each", () => {
    renderGrid(["a", "b", "c"], { mode: "horizontal", layout: { itemIds: ["c", "a", "b"], sizes: { a: 20, b: 30, c: 50 } } });

    const panels = [...document.querySelectorAll("[data-panel]")].map((panel) => panel.id);
    expect(panels).toEqual(["c", "a", "b"]);
    expect(screen.getAllByRole("separator", { name: "Resize pane" })).toHaveLength(2);
    expect(flexGrowOf("c")).toBe(50);
    expect(flexGrowOf("a")).toBe(20);
  });

  it.each(["vertical", "stack"] as const)("Given the %s mode, when it renders, then the panes are split vertically", (mode) => {
    renderGrid(["a", "b"], { mode });

    expect(document.querySelector("[data-group]")).toHaveStyle({ flexDirection: "column" });
    expect(screen.getByRole("separator", { name: "Resize pane" })).toHaveAttribute("aria-orientation", "horizontal");
  });

  it("Given the sidebar mode, when it renders, then the first pane is narrow and the others share the rest", () => {
    renderGrid(["a", "b", "c"], { mode: "sidebar" });

    expect(flexGrowOf("a")).toBe(26);
    expect(flexGrowOf("b")).toBe(37);
    expect(flexGrowOf("c")).toBe(37);
  });

  it("Given a single pane, when it renders, then it fills the group without a separator", () => {
    renderGrid(["a"]);

    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    expect(flexGrowOf("a")).toBe(100);
  });
});

describe("PaneGrid resizing", () => {
  withMeasuredLayout();

  it("Given split panes, when the user resizes with the keyboard, then the new sizes are persisted with the container's mode", () => {
    const { onLayoutChange } = renderGrid(["a", "b"], { mode: "horizontal", layout: { mode: "grid", columns: 2 } });

    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize pane" }), { key: "ArrowRight" });

    expect(onLayoutChange).toHaveBeenCalledWith({
      containerId: "container-1",
      layout: expect.objectContaining({ mode: "horizontal", columns: 2, itemIds: ["a", "b"] }),
    });
    const { sizes } = onLayoutChange.mock.calls[0][0].layout;
    expect(sizes.a).toBeGreaterThan(50);
    expect(sizes.a + sizes.b).toBeCloseTo(100);
  });

  it("Given the sidebar mode, when the user resizes, then the stored mode is kept", () => {
    const { onLayoutChange } = renderGrid(["a", "b"], { mode: "sidebar", layout: { mode: "vertical" } });

    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize pane" }), { key: "ArrowRight" });

    expect(onLayoutChange).toHaveBeenCalledWith(expect.objectContaining({ layout: expect.objectContaining({ mode: "vertical" }) }));
  });
});
