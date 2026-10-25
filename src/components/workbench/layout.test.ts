import { describe, expect, it } from "vitest";
import {
  CONTAINER_CLOSE_SEMANTICS,
  TAB_DETACH_SEMANTICS,
  TAB_KILL_SEMANTICS,
  defaultPanelSizes,
  defaultGridDimensions,
  gridDimensionsForLayout,
  layoutForPanelIds,
  nextLayout,
  orderedIds,
  resolveLayoutMode,
  workbenchModeForLayout,
  workspaceLayoutForMode,
  workspaceLayoutForGrid,
} from "./layout";

describe("workbench layout projection", () => {
  it("retains persisted order and appends new panes deterministically", () => {
    expect(orderedIds(["a", "b", "c"], ["c", "missing", "a", "c"])).toEqual(["c", "a", "b"]);
    expect(defaultPanelSizes(["a", "b"])).toEqual({ a: 50, b: 50 });
  });

  it("normalizes panel sizes and maps modes for the Terra surface", () => {
    expect(layoutForPanelIds({ mode: "auto", sizes: { a: 20, b: 80 } }, ["a", "b"])).toEqual({
      a: 20,
      b: 80,
    });
    const normalized = layoutForPanelIds(
      { mode: "horizontal", sizes: { a: 2, b: 3, c: 5 } },
      ["a", "b", "c"],
    );
    expect(normalized).toEqual({ a: 20, b: 30, c: 50 });
    expect(Object.values(normalized).reduce((sum, value) => sum + value, 0)).toBe(100);
    expect(resolveLayoutMode({ mode: "spotlight" })).toBe("spotlight");
    expect(resolveLayoutMode({ mode: "grid" }, "sidebar")).toBe("sidebar");
    expect(workbenchModeForLayout({ mode: "auto", metadata: { workbenchMode: "sidebar" } })).toBe("sidebar");
    expect(workspaceLayoutForMode({ mode: "auto" }, "sidebar")).toMatchObject({
      mode: "auto",
      metadata: { workbenchMode: "sidebar" },
    });
    expect(nextLayout("container-a", { mode: "auto", paneIds: ["pane-a"], sizes: { "pane-a": 100 } })).toEqual({
      containerId: "container-a",
      layout: { mode: "auto", itemIds: ["pane-a"], sizes: { "pane-a": 100 } },
    });
  });

  it("derives deterministic grid dimensions and preserves layout metadata", () => {
    expect(defaultGridDimensions(0)).toEqual({ columns: 1, rows: 1 });
    expect(defaultGridDimensions(5)).toEqual({ columns: 3, rows: 2 });
    expect(gridDimensionsForLayout({ mode: "grid", columns: 4, rows: 2 }, 2)).toEqual({
      columns: 4,
      rows: 2,
    });

    const layout = {
      mode: "grid" as const,
      itemIds: ["pane-a", "pane-b"],
      sizes: { "pane-a": 40, "pane-b": 60 },
      metadata: { workbenchMode: "grid", source: "test" },
    };
    expect(workspaceLayoutForGrid(layout, 2, { columns: 2, rows: 1 })).toEqual({
      ...layout,
      columns: 2,
      rows: 1,
    });
  });

  it("keeps visual close, detach, and explicit kill semantics distinct", () => {
    expect(CONTAINER_CLOSE_SEMANTICS.killsPtys).toBe(false);
    expect(CONTAINER_CLOSE_SEMANTICS.unmountsPanes).toBe(false);
    expect(TAB_DETACH_SEMANTICS.killsPty).toBe(false);
    expect(TAB_DETACH_SEMANTICS.unmountsSurface).toBe(false);
    expect(TAB_KILL_SEMANTICS.killsPty).toBe(true);
    expect(TAB_KILL_SEMANTICS.unmountsSurface).toBe(true);
  });
});
