import { describe, expect, it } from "vitest";
import { initials } from "./initials";

describe("initials", () => {
  it("Given a name of several words, when taking initials, then it joins the first letters of the first two", () => {
    expect(initials("Terra Swarm_app")).toBe("ts");
  });

  it("Given a single word, when taking initials, then it returns its first two letters", () => {
    expect(initials("Archive")).toBe("ar");
  });
});
