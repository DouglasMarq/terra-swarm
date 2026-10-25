export function storageGet(key: string): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    return;
  }
}

export function storageRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    return;
  }
}

export const safeStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
  getItem: storageGet,
  setItem: storageSet,
  removeItem: storageRemove,
};
