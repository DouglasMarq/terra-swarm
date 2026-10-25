import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview, type DragDropEvent } from "@tauri-apps/api/webview";

export type FileDropEvent = DragDropEvent;

export async function onFileDrop(handler: (event: FileDropEvent) => void): Promise<UnlistenFn> {
  return getCurrentWebview().onDragDropEvent((event) => handler(event.payload));
}
