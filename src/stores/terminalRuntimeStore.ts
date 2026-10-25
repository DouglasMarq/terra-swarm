import { create } from "zustand";
import type { NotificationItem, NotificationPayload } from "../domain/notification.model";
import type { ResumeItem, TitlePayload } from "../domain/terminal.model";

export const MAX_NOTIF_ITEMS = 50;

type TerminalRuntimeState = {
  exited: Record<string, number | null>;
  notifications: Record<string, number>;
  notifItems: NotificationItem[];
  contextUsage: Record<string, number>;
  titles: Record<string, string>;
  branches: Record<string, string>;
  resumeItems: ResumeItem[] | null;
  resumeSavedAt: number | null;
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
  let hasChanged = false;
  const next = { ...record };
  for (const key of keys) {
    if (!(key in next)) continue;
    hasChanged = true;
    delete next[key];
  }
  return hasChanged ? next : record;
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
          isRead: false,
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
      if (!state.notifItems.some((item) => item.terminalId === id && !item.isRead)) {
        return state;
      }
      return {
        notifItems: state.notifItems.map((item) =>
          item.terminalId === id ? { ...item, isRead: true } : item,
        ),
      };
    }),

  markAllRead: () =>
    set((state) => ({
      notifItems: state.notifItems.some((item) => !item.isRead)
        ? state.notifItems.map((item) => ({ ...item, isRead: true }))
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
          isRead: false,
          isSystem: true,
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
          isRead: false,
          isSystem: true,
          isUpdate: true,
        },
        ...state.notifItems.filter((item) => !item.isUpdate),
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
