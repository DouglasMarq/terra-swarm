import { create } from "zustand";
import type { NotificationItem, NotificationPayload } from "../domain/notification.model";
import type { ResumeItem, TitlePayload } from "../domain/terminal.model";

/** Maximum number of notification entries retained by the desktop client. */
export const MAX_NOTIF_ITEMS = 50;

type TerminalRuntimeState = {
  /** Exit code by terminal id. `null` means the process exited without a code. */
  exited: Record<string, number | null>;
  /** Number of unread notifications by terminal id. */
  notifications: Record<string, number>;
  /** Notification history shown by the top bar. */
  notifItems: NotificationItem[];
  /** Context usage reported by an agent, keyed by terminal id. */
  contextUsage: Record<string, number>;
  /** Dynamic terminal titles reported by the backend. */
  titles: Record<string, string>;
  /** Git branch by workspace id. */
  branches: Record<string, string>;
  /** Startup resume prompt state. */
  resumeItems: ResumeItem[] | null;
  resumeSavedAt: number | null;
  /** Monotonic key used by notification list entries. */
  nextNotificationKey: number;

  setExited: (value: RuntimeUpdater<Record<string, number | null>>) => void;
  setNotifications: (value: RuntimeUpdater<Record<string, number>>) => void;
  setNotifItems: (value: RuntimeUpdater<NotificationItem[]>) => void;
  setContextUsage: (value: RuntimeUpdater<Record<string, number>>) => void;
  setTitles: (value: RuntimeUpdater<Record<string, string>>) => void;
  setBranches: (value: RuntimeUpdater<Record<string, string>>) => void;
  setResumeItems: (value: RuntimeUpdater<ResumeItem[] | null>) => void;
  setResumeSavedAt: (value: RuntimeUpdater<number | null>) => void;
  clearExited: (id: string) => void;
  clearContextUsage: (id: string) => void;
  setTitle: (payload: TitlePayload) => void;
  clearTitle: (id: string) => void;
  addNotification: (payload: NotificationPayload) => void;
  clearNotificationCount: (id: string) => void;
  markTerminalRead: (id: string) => void;
  markAllRead: () => void;
  clearAllNotifications: () => void;
  pushSystemNotification: (message: string) => void;
  notifyUpdateAvailable: (version: string, current: string) => void;
  dropResumeItem: (terminalId: string) => void;
  clearTerminal: (id: string) => void;
  clearTerminals: (ids: string[]) => void;
  reset: () => void;
};

type RuntimeUpdater<T> = T | ((current: T) => T);

const resolveUpdate = <T>(value: RuntimeUpdater<T>, current: T): T =>
  typeof value === "function"
    ? (value as (current: T) => T)(current)
    : value;

const removeKey = <T>(record: Record<string, T>, key: string) => {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
};

const removeKeys = <T>(record: Record<string, T>, keys: Set<string>) => {
  let changed = false;
  const next = { ...record };
  for (const key of keys) {
    if (!(key in next)) continue;
    changed = true;
    delete next[key];
  }
  return changed ? next : record;
};

const sameRecord = (left: Record<string, string>, right: Record<string, string>) => {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key]);
};

export const useTerminalRuntimeStore = create<TerminalRuntimeState>((set) => ({
  exited: {},
  notifications: {},
  notifItems: [],
  contextUsage: {},
  titles: {},
  branches: {},
  resumeItems: null,
  resumeSavedAt: null,
  nextNotificationKey: 1,

  setExited: (value) =>
    set((state) => ({ exited: resolveUpdate(value, state.exited) })),

  setNotifications: (value) =>
    set((state) => ({
      notifications: resolveUpdate(value, state.notifications),
    })),

  setNotifItems: (value) =>
    set((state) => ({ notifItems: resolveUpdate(value, state.notifItems) })),

  setContextUsage: (value) =>
    set((state) => ({
      contextUsage: resolveUpdate(value, state.contextUsage),
    })),

  setTitles: (value) =>
    set((state) => ({ titles: resolveUpdate(value, state.titles) })),

  setBranches: (value) =>
    set((state) => {
      const branches = resolveUpdate(value, state.branches);
      return sameRecord(state.branches, branches) ? state : { branches };
    }),

  setResumeItems: (value) =>
    set((state) => ({ resumeItems: resolveUpdate(value, state.resumeItems) })),

  setResumeSavedAt: (value) =>
    set((state) => ({
      resumeSavedAt: resolveUpdate(value, state.resumeSavedAt),
    })),

  clearExited: (id) =>
    set((state) => ({ exited: removeKey(state.exited, id) })),

  clearContextUsage: (id) =>
    set((state) => ({ contextUsage: removeKey(state.contextUsage, id) })),

  setTitle: ({ id, title }) =>
    set((state) => ({ titles: { ...state.titles, [id]: title } })),

  clearTitle: (id) =>
    set((state) => ({ titles: removeKey(state.titles, id) })),

  addNotification: ({ id, workspace_id: workspaceId, count, messages }) =>
    set((state) => {
      const nextNotifications = {
        ...state.notifications,
        [id]: (state.notifications[id] ?? 0) + count,
      };
      if (messages.length === 0) return { notifications: nextNotifications };

      const firstKey = state.nextNotificationKey;
      const timestamp = Date.now();
      const added = messages
        .map((message, index) => ({
          key: firstKey + index,
          terminalId: id,
          workspaceId,
          message,
          ts: timestamp,
          read: false,
        }))
        .reverse();
      return {
        notifications: nextNotifications,
        notifItems: [...added, ...state.notifItems].slice(0, MAX_NOTIF_ITEMS),
        nextNotificationKey: firstKey + messages.length,
      };
    }),

  clearNotificationCount: (id) =>
    set((state) => ({ notifications: removeKey(state.notifications, id) })),

  markTerminalRead: (id) =>
    set((state) => {
      if (!state.notifItems.some((item) => item.terminalId === id && !item.read)) {
        return state;
      }
      return {
        notifItems: state.notifItems.map((item) =>
          item.terminalId === id ? { ...item, read: true } : item,
        ),
      };
    }),

  markAllRead: () =>
    set((state) => ({
      notifItems: state.notifItems.some((item) => !item.read)
        ? state.notifItems.map((item) => ({ ...item, read: true }))
        : state.notifItems,
      notifications: {},
    })),

  clearAllNotifications: () => set({ notifItems: [], notifications: {} }),

  pushSystemNotification: (message) =>
    set((state) => ({
      notifItems: [
        {
          key: state.nextNotificationKey,
          terminalId: "",
          workspaceId: "",
          message,
          ts: Date.now(),
          read: false,
          system: true,
        },
        ...state.notifItems,
      ].slice(0, MAX_NOTIF_ITEMS),
      nextNotificationKey: state.nextNotificationKey + 1,
    })),

  notifyUpdateAvailable: (version, current) =>
    set((state) => ({
      notifItems: [
        {
          key: state.nextNotificationKey,
          terminalId: "",
          workspaceId: "",
          message: `Version ${version} is available (installed: ${current}).`,
          ts: Date.now(),
          read: false,
          system: true,
          update: true,
        },
        ...state.notifItems.filter((item) => !item.update),
      ].slice(0, MAX_NOTIF_ITEMS),
      nextNotificationKey: state.nextNotificationKey + 1,
    })),

  dropResumeItem: (terminalId) =>
    set((state) => {
      if (!state.resumeItems) return state;
      const next = state.resumeItems.filter((item) => item.terminalId !== terminalId);
      return { resumeItems: next.length > 0 ? next : null };
    }),

  clearTerminal: (id) =>
    set((state) => ({
      exited: removeKey(state.exited, id),
      notifications: removeKey(state.notifications, id),
      notifItems: state.notifItems.filter((item) => item.terminalId !== id),
      contextUsage: removeKey(state.contextUsage, id),
      titles: removeKey(state.titles, id),
    })),

  clearTerminals: (ids) =>
    set((state) => {
      const keys = new Set(ids);
      if (keys.size === 0) return state;
      return {
        exited: removeKeys(state.exited, keys),
        notifications: removeKeys(state.notifications, keys),
        notifItems: state.notifItems.filter((item) => !keys.has(item.terminalId)),
        contextUsage: removeKeys(state.contextUsage, keys),
        titles: removeKeys(state.titles, keys),
      };
    }),

  reset: () =>
    set({
      exited: {},
      notifications: {},
      notifItems: [],
      contextUsage: {},
      titles: {},
      branches: {},
      resumeItems: null,
      resumeSavedAt: null,
      nextNotificationKey: 1,
    }),
}));

export type { TerminalRuntimeState };
