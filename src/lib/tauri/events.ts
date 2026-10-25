import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type { UnlistenFn };

export function listenPayload<T>(eventName: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(eventName, (event) => handler(event.payload));
}
