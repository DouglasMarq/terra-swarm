import { describe, expect, it } from "vitest";
import { basename } from "./basename";

describe("basename", () => {
  it("Given POSIX and Windows paths, when taking the basename, then it returns the last segment", () => {
    expect(basename("/work/terra-swarm/")).toBe("terra-swarm");
    expect(basename("C:\\work\\terra")).toBe("terra");
  });

  it("Given a path without segments, when taking the basename, then it returns an empty string", () => {
    expect(basename("/")).toBe("");
  });
});
