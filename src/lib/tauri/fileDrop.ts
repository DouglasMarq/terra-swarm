/**
 * Files dragged from the OS onto the window. Tauri takes the native drop
 * (`dragDropEnabled`, on by default), so the webview never gets an HTML
 * `drop` with files; this is the only way to learn their paths.
 */
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview, type DragDropEvent } from "@tauri-apps/api/webview";

export type FileDropEvent = DragDropEvent;

export async function onFileDrop(handler: (event: FileDropEvent) => void): Promise<UnlistenFn> {
  return getCurrentWebview().onDragDropEvent((event) => handler(event.payload));
}
