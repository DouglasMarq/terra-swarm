import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

let permission: Promise<boolean> | null = null;
export function ensureNotificationPermission(): Promise<boolean> {
  permission ??= isPermissionGranted()
    .then((granted) => granted || requestPermission().then((answer) => answer === "granted"))
    .catch((error) => {
      console.warn("notification permission check failed:", error);
      return false;
    });
  return permission;
}

export function showNotification(notification: { title: string; body: string }): void {
  sendNotification(notification);
}

export function setAppBadgeCount(count: number | undefined): Promise<void> {
  return getCurrentWindow().setBadgeCount(count);
}
