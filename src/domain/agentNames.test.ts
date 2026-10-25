import { describe, expect, it } from "vitest";
import { agentNamesInUse, namesSimilar, pickAgentName } from "./agentNames";

const list = ["Vega", "Lyra", "Lara", "Orion", "Rigel"];

describe("pickAgentName", () => {
  it("Given free names, when picking one, then the first free name is returned", () => {
    expect(pickAgentName([], list)).toBe("Vega");
    expect(pickAgentName(["Vega"], list, { shouldAvoidSimilar: false })).toBe("Lyra");
  });

  it("Given an open agent's name, when picking one, then names that start or sound alike are skipped", () => {
    expect(pickAgentName(["Lyra"], ["Lara", "Orion"])).toBe("Orion");
    expect(pickAgentName(["Vega", "Lyra"], list)).toBe("Orion");
  });

  it("Given only similar names are free, when picking one, then a similar free name is used before giving up", () => {
    expect(pickAgentName(["Lyra"], ["Lara"])).toBe("Lara");
  });

  it("Given the list is used up and the strategy keeps the numbered kind, when picking one, then null is returned", () => {
    expect(pickAgentName(["Vega"], ["Vega"], { exhausted: "type-number" })).toBeNull();
  });

  it("Given the repeat strategy, when the list is used up, then names repeat with a number", () => {
    expect(pickAgentName(["Vega"], ["Vega"], { exhausted: "repeat" })).toBe("Vega 2");
    expect(pickAgentName(["Vega", "Vega 2"], ["Vega"], { exhausted: "repeat" })).toBe("Vega 3");
  });
});

describe("namesSimilar", () => {
  it("Given two names, when comparing them, then one-letter differences and shared consonants count as similar", () => {
    expect(namesSimilar("Lyra", "Lara")).toBe(true);
    expect(namesSimilar("Vega", "Orion")).toBe(false);
    expect(namesSimilar("Tapajós", "tapajos")).toBe(true);
  });

  it("Given a blank name, when comparing, then nothing is similar", () => {
    expect(namesSimilar("", "Vega")).toBe(false);
    expect(namesSimilar("Vega", "  ")).toBe(false);
  });

  it.each([
    ["Mira", "Mila", true],
    ["Mira", "Mile", false],
    ["Spicka", "Spica", true],
    ["Spica", "Spicka", true],
    ["Deneb", "Denebs", true],
    ["Hydra", "Hxdr", false],
    ["Nova", "Novaxyz", false],
  ])("Given %s and %s, when their consonants differ, then one edit apart is %s", (...[first, second, isSimilar]) => {
    expect(namesSimilar(first, second)).toBe(isSimilar);
  });
});

describe("agentNamesInUse", () => {
  it("Given names for open and closed agents, when listing names in use, then only open agents' names count", () => {
    const workspaces = [{ id: "ws", name: "ws", cwd: "/ws", terminals: [{ id: "open", command: "claude", width: null }] }];

    expect(agentNamesInUse(workspaces, { open: "Vega", closed: "Lyra" })).toEqual(["Vega"]);
  });
});
