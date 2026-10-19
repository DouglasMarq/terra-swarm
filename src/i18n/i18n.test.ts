import { afterEach, describe, expect, it } from "vitest";
import { en } from "./locales/en";
import { ptBR } from "./locales/pt-BR";
import { DEFAULT_LOCALE, t, translate, useLocaleStore } from "./index";

function keys(node: unknown, prefix = ""): string[] {
  if (!node || typeof node !== "object") return [prefix];
  if ("other" in node) return [prefix];
  return Object.entries(node).flatMap(([key, value]) => keys(value, prefix ? `${prefix}.${key}` : key));
}

afterEach(() => useLocaleStore.getState().setLocale("pt-BR"));

describe("i18n", () => {
  it("defaults to English", () => {
    expect(DEFAULT_LOCALE).toBe("en");
  });

  it("keeps pt-BR in lockstep with the English source", () => {
    expect(keys(ptBR).sort()).toEqual(keys(en).sort());
  });

  it("interpolates variables and picks plural forms per locale", () => {
    expect(translate("en", "shell.attention.button", { count: 1 })).toBe("1 needs you");
    expect(translate("en", "shell.attention.button", { count: 3 })).toBe("3 need you");
    expect(translate("pt-BR", "shell.attention.button", { count: 1 })).toBe("1 precisa de você");
    expect(translate("pt-BR", "shell.sidebar.activeAgents", { count: 2 })).toBe("2 agentes ativos");
  });

  it("follows the selected locale for non-React callers", () => {
    useLocaleStore.getState().setLocale("en");
    expect(t("common.fleet")).toBe("Fleet");
    useLocaleStore.getState().setLocale("pt-BR");
    expect(t("common.fleet")).toBe("Frota");
  });

  it("falls back to the key when a message is missing", () => {
    expect(translate("en", "missing.key" as never)).toBe("missing.key");
  });
});
