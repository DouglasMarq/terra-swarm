import { useMemo, useState } from "react";
import { History } from "lucide-react";

import type { ResumeItem } from "../domain/terminal.model";
import { intlLocale, useT } from "../i18n";
import { COMMAND_PALETTE_SHORTCUT, formatShortcut } from "../lib/platform/shortcuts";
import { agentKind } from "../domain/agentLabels";
import { ConfirmActionDialog, TerraDialog } from "./overlays/Dialog";
import styles from "./integration/dialogs/ModalForms.module.css";

interface Props {
  items: ResumeItem[];
  savedAt: number | null;
  onResume: (item: ResumeItem) => void | Promise<void>;
  onDismiss: (item: ResumeItem) => void | Promise<void>;
  onResumeAll: () => void | Promise<void>;
  onDismissAll: () => void | Promise<void>;
  /** Hides this queue without mutating it. It can be reopened from ⌘K. */
  onDefer: () => void;
  /** Resume every saved session on startup without asking. */
  autoResume?: boolean;
  onAutoResumeChange?: (enabled: boolean) => void;
}

interface ResumeGroup {
  wsId: string;
  wsName: string;
  cwd: string;
  items: ResumeItem[];
}

function groupByProject(items: readonly ResumeItem[]): ResumeGroup[] {
  const groups = new Map<string, ResumeGroup>();
  for (const item of items) {
    const group = groups.get(item.wsId) ?? { wsId: item.wsId, wsName: item.wsName, cwd: item.cwd, items: [] };
    group.items.push(item);
    groups.set(item.wsId, group);
  }
  return [...groups.values()];
}

/**
 * Opening screen: "Continue where you left off?". Sessions are grouped by
 * project with checkboxes; unchecked ones stay saved and can be resumed later
 * from ⌘K. Discarding the whole queue still needs an explicit confirmation.
 */
export function ResumeDialog({
  items,
  onDefer,
  onDismissAll,
  onResume,
  onResumeAll,
  savedAt,
  autoResume = false,
  onAutoResumeChange,
}: Props) {
  const t = useT();
  const groups = useMemo(() => groupByProject(items), [items]);
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [confirmDismissAll, setConfirmDismissAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const selected = items.filter((item) => !unchecked.has(item.terminalId));

  const toggle = (ids: readonly string[], checked: boolean) => setUnchecked((current) => {
    const next = new Set(current);
    ids.forEach((id) => (checked ? next.delete(id) : next.add(id)));
    return next;
  });

  const resumeSelected = async () => {
    if (selected.length === 0) return;
    setBusy(true);
    try {
      if (selected.length === items.length) {
        await onResumeAll();
      } else {
        for (const item of selected) await onResume(item);
        onDefer();
      }
    } finally {
      setBusy(false);
    }
  };

  const savedLabel = savedAt != null
    ? new Date(savedAt).toLocaleString(intlLocale(), { weekday: "short", hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <>
      <TerraDialog
        className={styles.resumeDialog}
        description={savedLabel
          ? t("resume.descriptionAt", { count: items.length, when: savedLabel })
          : t("resume.description", { count: items.length })}
        onOpenChange={(open) => {
          if (!open) onDefer();
        }}
        open={items.length > 0}
        title={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <History aria-hidden="true" size={17} strokeWidth={1.8} />
            {t("resume.title")}
          </span>
        }
      >
        <div className={styles.resumeBody}>
          <div aria-live="polite" className={styles.resumeGroups}>
            {groups.map((group) => {
              const ids = group.items.map((item) => item.terminalId);
              const checkedCount = ids.filter((id) => !unchecked.has(id)).length;
              return (
                <section className={styles.resumeGroup} key={group.wsId} aria-label={group.wsName}>
                  <label className={styles.resumeGroupHead}>
                    <input
                      type="checkbox"
                      checked={checkedCount === ids.length}
                      ref={(input) => {
                        if (input) input.indeterminate = checkedCount > 0 && checkedCount < ids.length;
                      }}
                      onChange={(event) => toggle(ids, event.target.checked)}
                    />
                    <strong>{group.wsName}</strong>
                    <span>{t("resume.agentCount", { count: ids.length })}</span>
                  </label>
                  {group.items.map((item) => (
                    <label className={styles.resumeRow} key={item.terminalId}>
                      <input
                        type="checkbox"
                        checked={!unchecked.has(item.terminalId)}
                        onChange={(event) => toggle([item.terminalId], event.target.checked)}
                      />
                      <span className={styles.resumeRowCopy}>
                        <b>{agentKind(item.agentId || item.command)}</b>
                        <code>{item.resumeCommand}</code>
                      </span>
                    </label>
                  ))}
                </section>
              );
            })}
          </div>

          <div className={styles.resumeFooter}>
            <button type="button" className="terra-button terra-button-primary" disabled={busy || selected.length === 0} onClick={() => void resumeSelected()}>
              {t("resume.resumeSelected", { count: selected.length })}
            </button>
            <button type="button" className="terra-button" onClick={onDefer}>
              {t("resume.startFresh")}
            </button>
            <span className={styles.resumeSpacer} />
            <button type="button" className="terra-link-button" onClick={() => setConfirmDismissAll(true)}>
              {t("resume.discardAll")}
            </button>
          </div>
          {onAutoResumeChange ? (
            <label className={styles.resumeAuto}>
              <input type="checkbox" checked={autoResume} onChange={(event) => onAutoResumeChange(event.target.checked)} />
              {t("resume.always")}
            </label>
          ) : null}
          <p className={styles.resumeHint}>{t("resume.laterHint", { shortcut: formatShortcut(COMMAND_PALETTE_SHORTCUT) })}</p>
        </div>
      </TerraDialog>

      <ConfirmActionDialog
        intent="destructive"
        description={t("resume.discardDescription")}
        confirmLabel={t("resume.discardAll")}
        onConfirm={async () => {
          await onDismissAll();
          setConfirmDismissAll(false);
        }}
        onOpenChange={(open) => {
          if (!open) setConfirmDismissAll(false);
        }}
        open={confirmDismissAll}
        title={t("resume.discardTitle")}
      />
    </>
  );
}
