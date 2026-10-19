import { t } from "../../i18n";
import { Mic, MicOff } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";

import styles from "./voice.module.css";

export interface VoiceButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> {
  listening?: boolean;
  onStart?: () => void;
  onStop?: () => void;
  shortcut?: string;
  pushToTalk?: boolean;
}

/**
 * Small, composable microphone control.  The parent owns recording state;
 * this button only emits the intent to start/stop and advertises the shortcut.
 */
export function VoiceButton({
  ariaLabel,
  className,
  listening = false,
  onStart,
  onStop,
  pushToTalk = false,
  shortcut,
  title,
  ...buttonProps
}: VoiceButtonProps & { ariaLabel?: string }) {
  const label = ariaLabel ?? (listening ? t("palette.voiceStop") : t("palette.voiceStart"));
  const hint = [pushToTalk ? t("voiceCapsule.holdToTalk") : null, shortcut].filter(Boolean).join(" · ");
  const classes = [styles.voiceButton, className].filter(Boolean).join(" ");

  return (
    <button
      {...buttonProps}
      type={buttonProps.type ?? "button"}
      className={classes}
      aria-label={label}
      aria-pressed={listening}
      data-listening={listening || undefined}
      title={title ?? (hint ? `${label} (${hint})` : label)}
      onClick={() => (listening ? onStop?.() : onStart?.())}
    >
      {listening ? <MicOff aria-hidden="true" size={16} /> : <Mic aria-hidden="true" size={16} />}
      <span className={styles.srOnly}>{label}</span>
    </button>
  );
}
