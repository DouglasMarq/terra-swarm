import { Clock3, Copy, History, Play, Trash2 } from "lucide-react";
import { useState } from "react";

import type { ResumeItem } from "../types";
import { ConfirmActionDialog, TerraDialog } from "./overlays/Dialog";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import styles from "./integration/dialogs/ModalForms.module.css";

interface Props {
  items: ResumeItem[];
  savedAt: number | null;
  onResume: (item: ResumeItem) => void | Promise<void>;
  onDismiss: (item: ResumeItem) => void | Promise<void>;
  onResumeAll: () => void | Promise<void>;
  onDismissAll: () => void | Promise<void>;
  /** Hides this queue without mutating it. It can be reopened from Home. */
  onDefer: () => void;
}

function formatRelativeTime(ms: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 60) return "agora";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  return `há ${Math.floor(hours / 24)} d`;
}

async function copyText(value: string) {
  try {
    await navigator.clipboard?.writeText(value);
  } catch {
    // Clipboard permissions are optional; the resume action remains usable.
  }
}

/**
 * Startup queue for persisted sessions. Closing, Escape and “Agora não” only
 * hide the dialog: destructive queue mutations always pass through an
 * explicit confirmation dialog.
 */
export function ResumeDialog({
  items,
  onDefer,
  onDismiss,
  onDismissAll,
  onResume,
  onResumeAll,
  savedAt,
}: Props) {
  const [pendingDismiss, setPendingDismiss] = useState<ResumeItem | null>(null);
  const [confirmDismissAll, setConfirmDismissAll] = useState(false);

  return (
    <>
      <TerraDialog
        className={styles.resumeDialog}
        description="Estas sessões estavam ativas quando o Terra foi fechado. Retome-as agora ou deixe a fila para depois."
        onOpenChange={(open) => {
          if (!open) onDefer();
        }}
        open={items.length > 0}
        title={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <History aria-hidden="true" size={17} strokeWidth={1.8} />
            Retomar seus agentes
            <Badge size="sm" shape="pill">{items.length}</Badge>
          </span>
        }
      >
        <div className={styles.resumeBody}>
          <div aria-live="polite" className={styles.resumeList}>
            {items.map((item) => (
              <article className={styles.resumeItem} key={item.terminalId}>
                <div className={styles.resumeItemTop}>
                  <Badge size="sm" tone="agent">{item.agentId}</Badge>
                  <span className={styles.resumeTime}>
                    <Clock3 aria-hidden="true" size={12} /> {savedAt != null ? formatRelativeTime(savedAt) : "salva anteriormente"}
                  </span>
                  <button
                    aria-label={`Descartar sessão de ${item.wsName}`}
                    className={styles.iconButton}
                    data-danger="true"
                    onClick={() => setPendingDismiss(item)}
                    title="Descartar sessão salva"
                    type="button"
                  >
                    <Trash2 aria-hidden="true" size={14} strokeWidth={1.8} />
                  </button>
                </div>
                <strong>{item.wsName}</strong>
                <span className={styles.resumeCwd} title={item.cwd}>{item.cwd || "Diretório atual"}</span>
                <div className={styles.resumeCommandRow}>
                  <code className={styles.resumeCommand}>{item.resumeCommand}</code>
                  <button
                    aria-label={`Copiar comando de ${item.wsName}`}
                    className={styles.iconButton}
                    onClick={() => void copyText(item.resumeCommand)}
                    title="Copiar comando"
                    type="button"
                  >
                    <Copy aria-hidden="true" size={13} strokeWidth={1.8} />
                  </button>
                </div>
                <div className={styles.resumeActions}>
                  <Button
                    leadingIcon={<Play aria-hidden="true" size={12} fill="currentColor" />}
                    onClick={() => void onResume(item)}
                    size="sm"
                    type="button"
                    variant="primary"
                  >
                    Retomar
                  </Button>
                </div>
              </article>
            ))}
          </div>
          <div className={styles.resumeFooter}>
            <span className={styles.resumeSessions}>
              {items.length} {items.length === 1 ? "sessão" : "sessões"}
            </span>
            <div className={styles.resumeActions}>
              <Button onClick={onDefer} type="button" variant="ghost">
                Agora não
              </Button>
              <Button onClick={() => setConfirmDismissAll(true)} type="button" variant="danger">
                Descartar todas
              </Button>
              <Button
                leadingIcon={<Play aria-hidden="true" size={12} fill="currentColor" />}
                onClick={() => void onResumeAll()}
                type="button"
                variant="primary"
              >
                Retomar todas ({items.length})
              </Button>
            </div>
          </div>
        </div>
      </TerraDialog>

      <ConfirmActionDialog
        description={
          pendingDismiss
            ? `A sessão de “${pendingDismiss.wsName}” será removida da fila e não poderá ser retomada por este fluxo.`
            : "Todas as sessões salvas serão removidas da fila e não poderão ser retomadas por este fluxo."
        }
        onConfirm={async () => {
          if (pendingDismiss) {
            await onDismiss(pendingDismiss);
            setPendingDismiss(null);
          } else {
            await onDismissAll();
            setConfirmDismissAll(false);
          }
        }}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDismiss(null);
            setConfirmDismissAll(false);
          }
        }}
        open={pendingDismiss !== null || confirmDismissAll}
        title={pendingDismiss ? "Descartar esta sessão?" : "Descartar todas as sessões?"}
      />
    </>
  );
}
