import { describe, expect, it } from "vitest";
import { cloneLayout, mergeWorkspaceLayout, normalizeLayout } from "./workspaceLayout";

describe("workspace layout", () => {
  it("Given a full layout, when cloning it, then every field is copied without sharing arrays or objects", () => {
    const layout = { mode: "grid" as const, columns: 2, rows: 3, itemIds: ["a"], sizes: { a: 1 }, metadata: { pinned: true } };

    const copy = cloneLayout(layout);

    expect(copy).toEqual(layout);
    expect(copy.itemIds).not.toBe(layout.itemIds);
    expect(copy.sizes).not.toBe(layout.sizes);
    expect(copy.metadata).not.toBe(layout.metadata);
    expect(cloneLayout({ mode: "auto" })).toEqual({ mode: "auto" });
  });

  it("Given raw layout values, when normalizing, then invalid sizes and counts are dropped and valid ones rounded", () => {
    const normalized = normalizeLayout({
      mode: "vertical",
      columns: 2.6,
      rows: 0,
      itemIds: ["a", "a", "b"],
      sizes: { a: 2, b: 0, "": 3, c: "wide" },
      metadata: { focus: "a" },
    });

    expect(normalized).toEqual({ mode: "vertical", columns: 3, itemIds: ["a", "b"], sizes: { a: 2 }, metadata: { focus: "a" } });
  });

  it("Given an unknown mode, when normalizing with a fallback, then the fallback mode is used", () => {
    expect(normalizeLayout({ mode: "diagonal", rows: 1.2 }, { mode: "stack" })).toEqual({ mode: "stack", rows: 1, itemIds: [] });
    expect(normalizeLayout(null)).toEqual({ mode: "auto", itemIds: [] });
  });

  it("Given a previous and an incoming layout, when merging, then previous choices win and ids are limited to the valid ones", () => {
    const merged = mergeWorkspaceLayout(
      {
        previous: { mode: "horizontal", itemIds: ["a"], sizes: { a: 3 } },
        incoming: { mode: "grid", columns: 2, itemIds: ["b", "gone"], sizes: { a: 1, b: 2 } },
      },
      new Set(["a", "b"]),
    );

    expect(merged).toEqual({ mode: "horizontal", columns: 2, itemIds: ["a", "b"], sizes: { a: 3, b: 2 } });
  });

  it("Given no layouts, when merging, then the default layout without sizes comes back", () => {
    expect(mergeWorkspaceLayout({ previous: undefined, incoming: undefined }, new Set())).toEqual({ mode: "auto", itemIds: [] });
  });
});
