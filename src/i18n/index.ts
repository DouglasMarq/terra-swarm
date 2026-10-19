import { useCallback } from "react";
import { create } from "zustand";
import { en } from "./locales/en";
import { ptBR } from "./locales/pt-BR";

/**
 * Tiny, dependency-free i18n.
 *
 * - English is the source dictionary and the default locale; every other
 *   locale must provide the same keys (enforced by the `Dictionary` type).
 * - Keys are dotted paths ("shell.search.label"). A leaf is either a string
 *   or a plural object `{ one, other }` chosen with `Intl.PluralRules`.
 * - `{name}` placeholders are replaced from the `vars` argument.
 */

export type Locale = "en" | "pt-BR";

export const LOCALES: readonly { id: Locale; label: string }[] = [
  { id: "en", label: "English" },
  { id: "pt-BR", label: "Português (Brasil)" },
];

export const DEFAULT_LOCALE: Locale = "en";
const STORAGE_KEY = "locale";

export interface PluralLeaf {
  zero?: string;
  one: string;
  other: string;
}

type Leaf = string | PluralLeaf;

/** Same shape as the English source, with any string values. */
export type Dictionary<T> = {
  [K in keyof T]: T[K] extends string ? string : T[K] extends PluralLeaf ? PluralLeaf : Dictionary<T[K]>;
};

type Leaves<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends Leaf ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type MessageKey = Leaves<typeof en>;
export type MessageVars = Readonly<Record<string, string | number | null | undefined>>;
export type Translate = (key: MessageKey, vars?: MessageVars) => string;

const DICTIONARIES: Record<Locale, Dictionary<typeof en>> = {
  en,
  "pt-BR": ptBR,
};

function isLocale(value: unknown): value is Locale {
  return value === "en" || value === "pt-BR";
}

function readStoredLocale(): Locale {
  try {
    const stored = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
    return isLocale(stored) ? stored : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

function lookup(dictionary: unknown, key: string): Leaf | undefined {
  let node: unknown = dictionary;
  for (const part of key.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node === "string") return node;
  if (node && typeof node === "object" && "other" in node) return node as PluralLeaf;
  return undefined;
}

const pluralRules = new Map<Locale, Intl.PluralRules>();

function pluralFor(locale: Locale, count: number): Intl.LDMLPluralRule {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  return rules.select(count);
}

export function translate(locale: Locale, key: MessageKey | string, vars?: MessageVars): string {
  const leaf = lookup(DICTIONARIES[locale], key) ?? lookup(DICTIONARIES[DEFAULT_LOCALE], key);
  if (leaf === undefined) return key;
  let template: string;
  if (typeof leaf === "string") {
    template = leaf;
  } else {
    const count = Number(vars?.count ?? 0);
    // Zero reads as plural in both locales ("0 agents", "0 agentes"); CLDR
    // would make Portuguese singular here.
    template = count === 0
      ? leaf.zero ?? leaf.other
      : pluralFor(locale, count) === "one" ? leaf.one : leaf.other;
  }
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined || value === null ? match : String(value);
  });
}

interface LocaleState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

export const useLocaleStore = create<LocaleState>((set) => ({
  locale: readStoredLocale(),
  setLocale: (locale) => {
    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // Storage can be unavailable in restricted web views.
    }
    if (typeof document !== "undefined") document.documentElement.lang = locale;
    set({ locale });
  },
}));

/** Non-React access, e.g. inside stores or event handlers. */
export function t(key: MessageKey, vars?: MessageVars): string {
  return translate(useLocaleStore.getState().locale, key, vars);
}

export function useLocale(): Locale {
  return useLocaleStore((state) => state.locale);
}

/** Re-renders the caller when the locale changes. */
export function useT(): Translate {
  const locale = useLocale();
  return useCallback((key: MessageKey, vars?: MessageVars) => translate(locale, key, vars), [locale]);
}

/** BCP 47 tag for Intl date/number formatting. */
export function intlLocale(locale: Locale = useLocaleStore.getState().locale): string {
  return locale === "pt-BR" ? "pt-BR" : "en-US";
}
