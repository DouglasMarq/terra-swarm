/**
 * Folds text for search: no accents, lower case, no surrounding whitespace,
 * so "orquestracao" finds "Orquestração".
 */
export function normalizeSearchText(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("pt-BR").trim();
}
