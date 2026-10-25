import { useT } from "../../i18n";
import { Mic, MicOff } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";

import styles from "./voice.module.css";

export interface VoiceButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> {
  isListening?: boolean;
  onStart?: () => void;
  onStop?: () => void;
  shortcut?: string;
  isPushToTalk?: boolean;
}

export function VoiceButton({
  ariaLabel,
  className,
  isListening = false,
  onStart,
  onStop,
  isPushToTalk = false,
  shortcut,
  title,
  ...buttonProps
}: VoiceButtonProps & { ariaLabel?: string }) {
  const translate = useT();
  const label = ariaLabel ?? (isListening ? translate("palette.voiceStop") : translate("palette.voiceStart"));
  const hint = [isPushToTalk ? translate("voiceCapsule.holdToTalk") : null, shortcut].filter(Boolean).join(" · ");
  const classes = [styles.voiceButton, className].filter(Boolean).join(" ");

  return (
    <button
      {...buttonProps}
      type={buttonProps.type ?? "button"}
      className={classes}
      aria-label={label}
      aria-pressed={isListening}
      data-listening={isListening || undefined}
      title={title ?? (hint ? `${label} (${hint})` : label)}
      onClick={() => (isListening ? onStop?.() : onStart?.())}
    >
      {isListening ? <MicOff aria-hidden="true" size={16} /> : <Mic aria-hidden="true" size={16} />}
      <span className={styles.srOnly}>{label}</span>
    </button>
  );
}
