import { afterEach, describe, expect, it, vi } from "vitest";
import { safeStorage, storageGet, storageRemove, storageSet } from "./safeStorage";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
    clear: () => values.clear(),
    key: () => null,
    get length() {
      return values.size;
    },
  };
}

function failingStorage(): Storage {
  const fail = () => {
    throw new Error("storage disabled");
  };
  return { getItem: fail, setItem: fail, removeItem: fail, clear: fail, key: fail, length: 0 };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("safeStorage", () => {
  it("Given available storage, when writing, reading and removing a key, then it round-trips the value", () => {
    vi.stubGlobal("localStorage", memoryStorage());

    storageSet("theme", "dark");
    expect(storageGet("theme")).toBe("dark");
    storageRemove("theme");
    expect(safeStorage.getItem("theme")).toBeNull();
  });

  it("Given no storage at all, when reading or writing, then it reads null and does not throw", () => {
    vi.stubGlobal("localStorage", undefined);

    expect(() => storageSet("theme", "dark")).not.toThrow();
    expect(() => storageRemove("theme")).not.toThrow();
    expect(storageGet("theme")).toBeNull();
  });

  it("Given storage that throws, when reading or writing, then it reads null and does not throw", () => {
    vi.stubGlobal("localStorage", failingStorage());

    expect(() => safeStorage.setItem("theme", "dark")).not.toThrow();
    expect(() => safeStorage.removeItem("theme")).not.toThrow();
    expect(storageGet("theme")).toBeNull();
  });
});
