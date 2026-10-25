import { afterEach, describe, expect, it } from "vitest";
import { en } from "./locales/en";
import { ptBR } from "./locales/pt-BR";
import { DEFAULT_LOCALE, translateNow, translate, useLocaleStore } from "./index";

function keys(node: unknown, prefix = ""): string[] {
  if (!node || typeof node !== "object") return [prefix];
  if ("other" in node) return [prefix];
  return Object.entries(node).flatMap(([key, value]) => keys(value, prefix ? `${prefix}.${key}` : key));
}

afterEach(() => useLocaleStore.getState().setLocale("pt-BR"));

describe("i18n", () => {
  it("Given no chosen locale, when translating, then English is the default", () => {
    expect(DEFAULT_LOCALE).toBe("en");
  });

  it("Given the English source, when comparing pt-BR, then it has the same keys", () => {
    expect(keys(ptBR).sort()).toEqual(keys(en).sort());
  });

  it("Given variables and counts, when translating, then variables are interpolated and plural forms are picked per locale", () => {
    expect(translate("en", "shell.attention.button", { count: 1 })).toBe("1 needs you");
    expect(translate("en", "shell.attention.button", { count: 3 })).toBe("3 need you");
    expect(translate("pt-BR", "shell.attention.button", { count: 1 })).toBe("1 precisa de você");
    expect(translate("pt-BR", "shell.sidebar.activeAgents", { count: 2 })).toBe("2 agentes ativos");
  });

  it("Given a selected locale, when a non-React caller translates, then it follows that locale", () => {
    useLocaleStore.getState().setLocale("en");
    expect(translateNow("common.fleet")).toBe("Fleet");
    useLocaleStore.getState().setLocale("pt-BR");
    expect(translateNow("common.fleet")).toBe("Frota");
  });

  it("Given a label with a shortcut or a path, when translating, then each locale formats them in one message", () => {
    expect(translate("en", "common.withShortcut", { label: "Close inspector", shortcut: "⌘I" })).toBe("Close inspector (⌘I)");
    expect(translate("pt-BR", "settingsPanels.filePath", { path: "/Users/me/terra.json" })).toBe("Arquivo: /Users/me/terra.json");
  });

  it("Given a missing message, when translating, then the key is returned", () => {
    expect(translate("en", "missing.key" as never)).toBe("missing.key");
  });
});
