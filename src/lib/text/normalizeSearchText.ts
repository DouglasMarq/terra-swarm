export function normalizeSearchText(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("pt-BR").trim();
}
