import type { Terminal } from "@xterm/xterm";

const registry = new Map<string, Terminal>();

export function registerTerminal(id: string, term: Terminal): void {
  registry.set(id, term);
}

export function unregisterTerminal(id: string, term: Terminal): void {
  if (registry.get(id) === term) registry.delete(id);
}

export function getTerminal(id: string): Terminal | undefined {
  return registry.get(id);
}
