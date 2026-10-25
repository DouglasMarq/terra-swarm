import { useEffect, useState } from "react";
import { MS_PER_HOUR } from "../../lib/time/durations";

const NOTIFICATIONS_MUTE_MS = MS_PER_HOUR;

export interface NotificationMute {
  isMuted: boolean;
  toggleMute: () => void;
}

export function useNotificationMute(): NotificationMute {
  const [muteUntil, setMuteUntil] = useState(0);
  const isMuted = muteUntil > Date.now();
  useEffect(() => {
    if (muteUntil <= Date.now()) return;
    const timer = window.setTimeout(() => setMuteUntil(0), muteUntil - Date.now());
    return () => window.clearTimeout(timer);
  }, [muteUntil]);
  return {
    isMuted,
    toggleMute: () => setMuteUntil(isMuted ? 0 : Date.now() + NOTIFICATIONS_MUTE_MS),
  };
}
