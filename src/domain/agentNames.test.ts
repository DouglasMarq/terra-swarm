import { describe, expect, it } from "vitest";
import { agentNamesInUse, namesSimilar, pickAgentName } from "./agentNames";

const list = ["Vega", "Lyra", "Lara", "Orion", "Rigel"];

describe("pickAgentName", () => {
  it("returns the first free name", () => {
    expect(pickAgentName([], list)).toBe("Vega");
    expect(pickAgentName(["Vega"], list, { shouldAvoidSimilar: false })).toBe("Lyra");
  });

  it("skips names that start alike or sound alike an open agent", () => {
    expect(pickAgentName(["Lyra"], ["Lara", "Orion"])).toBe("Orion");
    expect(pickAgentName(["Vega", "Lyra"], list)).toBe("Orion");
  });

  it("falls back to a similar free name before giving up", () => {
    expect(pickAgentName(["Lyra"], ["Lara"])).toBe("Lara");
  });

  it("returns null when the list is used up and the strategy keeps the numbered kind", () => {
    expect(pickAgentName(["Vega"], ["Vega"], { exhausted: "type-number" })).toBeNull();
  });

  it("repeats names with a number when asked", () => {
    expect(pickAgentName(["Vega"], ["Vega"], { exhausted: "repeat" })).toBe("Vega 2");
    expect(pickAgentName(["Vega", "Vega 2"], ["Vega"], { exhausted: "repeat" })).toBe("Vega 3");
  });
});

describe("namesSimilar", () => {
  it("catches one-letter differences and shared consonants", () => {
    expect(namesSimilar("Lyra", "Lara")).toBe(true);
    expect(namesSimilar("Vega", "Orion")).toBe(false);
    expect(namesSimilar("Tapajós", "tapajos")).toBe(true);
  });
});

describe("agentNamesInUse", () => {
  it("Given names for open and closed agents, when listing names in use, then only open agents' names count", () => {
    const workspaces = [{ id: "ws", name: "ws", cwd: "/ws", terminals: [{ id: "open", command: "claude", width: null }] }];

    expect(agentNamesInUse(workspaces, { open: "Vega", closed: "Lyra" })).toEqual(["Vega"]);
  });
});
