import * as TabsPrimitive from "@radix-ui/react-tabs";
import { useT } from "../../i18n";
import { Search, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  ConfirmActionDialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  type ActionIntent,
} from "../overlays/Dialog";
import {
  filterSettingsSections,
  getInitialSettingsSection,
  SETTINGS_SECTIONS,
  type SettingsSectionDefinition,
  type SettingsSectionId,
} from "./settingsModel";
import { formatShortcut } from "../../lib/platform/shortcuts";
import styles from "./SettingsDialog.module.css";

const cx = (...classes: Array<string | undefined | false>) => classes.filter(Boolean).join(" ");
const SEARCH_HOTKEY = { key: "k", meta: true, shift: false, ctrl: false, alt: false } as const;

export interface SettingsConfirmationRequest {
  title: ReactNode;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  intent?: ActionIntent;
  onConfirm: () => void | Promise<void>;
}

export interface SettingsSectionRenderContext {
  section: SettingsSectionDefinition;
  close: () => void;
  requestConfirmation: (request: SettingsConfirmationRequest) => void;
}

export type SettingsSectionSlot =
  | ReactNode
  | ((context: SettingsSectionRenderContext) => ReactNode);

export interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeSection?: SettingsSectionId;
  defaultSection?: SettingsSectionId;
  onActiveSectionChange?: (section: SettingsSectionId) => void;
  sections?: readonly SettingsSectionDefinition[];
  /** A slot map is useful when forms already live in the host application. */
  slots?: Partial<Record<SettingsSectionId, SettingsSectionSlot>>;
  /** Render prop takes precedence over the matching slot. */
  renderSection?: (context: SettingsSectionRenderContext) => ReactNode;
  headerSlot?: ReactNode | (() => ReactNode);
  footerSlot?: ReactNode | (() => ReactNode);
  title?: ReactNode;
  description?: ReactNode;
  searchPlaceholder?: string;
  className?: string;
  /** "page" renders inline as a surface instead of a modal dialog. */
  variant?: "dialog" | "page";
}

function renderSlot(
  slot: SettingsSectionSlot | ReactNode | (() => ReactNode) | undefined,
  context: SettingsSectionRenderContext,
): ReactNode {
  return typeof slot === "function" ? (slot as (context: SettingsSectionRenderContext) => ReactNode)(context) : slot;
}

function DefaultSectionContent({ section }: { section: SettingsSectionDefinition }) {
  return (
    <div className={styles.defaultSection}>
      <div className={styles.sectionKicker}>{section.label}</div>
      <h3 className={styles.defaultTitle}>Configure o {section.label.toLocaleLowerCase("pt-BR")}</h3>
      <p className={styles.defaultDescription}>{section.description}</p>
      <div className={styles.placeholderCard}>
        <span className={styles.placeholderDot} aria-hidden="true" />
        <div>
          <strong>Pronto para receber o módulo Terra</strong>
          <span>O host pode injetar o formulário desta seção via <code>slots</code> ou <code>renderSection</code>.</span>
        </div>
      </div>
    </div>
  );
}

/** Full Terra settings surface with independently scrolling navigation and content. */
export function SettingsDialog({
  activeSection,
  className,
  defaultSection,
  description,
  footerSlot,
  headerSlot,
  onActiveSectionChange,
  onOpenChange,
  open,
  renderSection,
  searchPlaceholder,
  sections = SETTINGS_SECTIONS,
  slots = {},
  title,
  variant = "dialog",
}: SettingsDialogProps) {
  const t = useT();
  const isPage = variant === "page";
  const resolvedTitle = title ?? t("settings.title");
  const resolvedDescription = description ?? t("settings.description");
  const firstSection = useMemo(
    () => getInitialSettingsSection(sections, activeSection ?? defaultSection),
    [activeSection, defaultSection, sections],
  );
  const [uncontrolledSection, setUncontrolledSection] = useState<SettingsSectionId | undefined>(firstSection);
  const [query, setQuery] = useState("");
  const [confirmation, setConfirmation] = useState<SettingsConfirmationRequest | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRefs = useRef<Partial<Record<SettingsSectionId, HTMLButtonElement | null>>>({});

  useEffect(() => {
    if (firstSection && !activeSection && !sections.some((section) => section.id === uncontrolledSection)) {
      setUncontrolledSection(firstSection);
    }
  }, [activeSection, firstSection, sections, uncontrolledSection]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setConfirmation(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open || isPage) return undefined;

    function focusSearch(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase("en-US") === "k") {
        event.preventDefault();
        event.stopPropagation();
        searchRef.current?.focus();
      }
    }

    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, [isPage, open]);

  const visibleSections = useMemo(() => filterSettingsSections(sections, query), [query, sections]);
  const selectedSection = activeSection ?? uncontrolledSection ?? firstSection;
  const activeTab = visibleSections.some((section) => section.id === selectedSection)
    ? selectedSection
    : visibleSections[0]?.id ?? selectedSection;

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const requestConfirmation = useCallback((request: SettingsConfirmationRequest) => {
    setConfirmation(request);
  }, []);

  function selectSection(value: string) {
    const section = sections.find((candidate) => candidate.id === value);
    if (!section) return;
    if (!activeSection) setUncontrolledSection(section.id);
    onActiveSectionChange?.(section.id);
  }

  function moveFocusFromSearch(direction: "first" | "last" | "active") {
    const target = direction === "last"
      ? visibleSections[visibleSections.length - 1]?.id
      : direction === "active"
        ? activeTab ?? visibleSections[0]?.id
        : visibleSections[0]?.id;
    if (target) triggerRefs.current[target]?.focus();
  }

  const renderContent = useCallback(
    (section: SettingsSectionDefinition) => {
      const context: SettingsSectionRenderContext = { close, requestConfirmation, section };
      const custom = renderSection?.(context) ?? renderSlot(slots[section.id], context);
      return custom ?? <DefaultSectionContent section={section} />;
    },
    [close, renderSection, requestConfirmation, slots],
  );
  const activeSectionDefinition = sections.find((section) => section.id === activeTab) ?? sections[0] ?? SETTINGS_SECTIONS[0];
  const headerContext: SettingsSectionRenderContext = {
    close,
    requestConfirmation,
    section: sections[0] ?? SETTINGS_SECTIONS[0],
  };
  const footerContext: SettingsSectionRenderContext = {
    close,
    requestConfirmation,
    section: activeSectionDefinition,
  };
  const renderedHeaderSlot = renderSlot(headerSlot, headerContext);
  const renderedFooterSlot = renderSlot(footerSlot, footerContext);

  const body = (
            <TabsPrimitive.Root
              className={styles.tabsRoot}
              orientation="vertical"
              value={activeTab}
              onValueChange={selectSection}
            >
              <aside className={styles.sidebar} aria-label={t("settings.categories")}>
                <label className={styles.searchBox}>
                  <Search aria-hidden="true" size={15} strokeWidth={1.8} />
                  <input
                    ref={searchRef}
                    aria-label={t("settings.search")}
                    className={styles.searchInput}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown" || event.key === "Enter") {
                        event.preventDefault();
                        moveFocusFromSearch("active");
                      } else if (event.key === "ArrowUp") {
                        event.preventDefault();
                        moveFocusFromSearch("last");
                      } else if (event.key === "Escape" && query) {
                        event.preventDefault();
                        setQuery("");
                        searchRef.current?.focus();
                      }
                    }}
                    placeholder={searchPlaceholder ?? t("settings.searchPlaceholder")}
                    type="search"
                    value={query}
                  />
                  <kbd className={styles.searchShortcut}>{formatShortcut(SEARCH_HOTKEY)}</kbd>
                </label>
                <div className={styles.resultCount} aria-live="polite">
                  {query ? t("settings.results", { count: visibleSections.length }) : resolvedTitle}
                </div>
                <TabsPrimitive.List className={styles.sectionList} aria-label={t("settings.sectionsLabel")}>
                  {visibleSections.map((section) => {
                    const Icon = section.icon;
                    return (
                      <TabsPrimitive.Trigger
                        className={styles.sectionTrigger}
                        key={section.id}
                        ref={(node) => {
                          triggerRefs.current[section.id] = node;
                        }}
                        value={section.id}
                      >
                        <Icon aria-hidden="true" className={styles.sectionIcon} size={16} strokeWidth={1.7} />
                        <span className={styles.sectionLabel}>{section.label}</span>
                      </TabsPrimitive.Trigger>
                    );
                  })}
                </TabsPrimitive.List>
                <div className={styles.sidebarHint}>
                  <span className={styles.sidebarHintKey}>↑↓</span>
                  <span>{t("settings.navigate")}</span>
                  {isPage ? null : <><span className={styles.sidebarHintKey}>Esc</span><span>{t("common.close")}</span></>}
                </div>
              </aside>

              <main className={styles.main}>
                {visibleSections.length === 0 ? (
                  <div className={styles.emptyState} role="status">
                    <Search aria-hidden="true" size={20} strokeWidth={1.5} />
                    <strong>{t("settings.emptyTitle")}</strong>
                    <span>{t("settings.emptyBody")}</span>
                  </div>
                ) : (
                  visibleSections.map((section) => (
                    <TabsPrimitive.Content
                      className={styles.sectionContent}
                      key={section.id}
                      value={section.id}
                    >
                      {renderContent(section)}
                    </TabsPrimitive.Content>
                  ))
                )}
                {renderedFooterSlot ? <div className={styles.dialogFooter}>{renderedFooterSlot}</div> : null}
              </main>
            </TabsPrimitive.Root>
  );

  const confirmDialog = (
    <ConfirmActionDialog
      open={confirmation !== null}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setConfirmation(null);
      }}
      title={confirmation?.title ?? t("common.confirm")}
      description={confirmation?.description ?? ""}
      confirmLabel={confirmation?.confirmLabel}
      cancelLabel={confirmation?.cancelLabel}
      intent={confirmation?.intent ?? "destructive"}
      onConfirm={async () => {
        await confirmation?.onConfirm();
        setConfirmation(null);
      }}
    />
  );

  if (isPage) {
    return (
      <>
        <section className={cx(styles.page, className)} aria-label={typeof resolvedTitle === "string" ? resolvedTitle : undefined}>
          {body}
        </section>
        {confirmDialog}
      </>
    );
  }

  return (
    <>
      <DialogRoot open={open} onOpenChange={onOpenChange}>
        <DialogPortal>
          <DialogOverlay className={styles.overlay} />
          <DialogContent
            aria-describedby="terra-settings-description"
            className={cx(styles.dialogContent, className)}
          >
            <div className={styles.dialogHeader}>
              <div className={styles.titleBlock}>
                <DialogTitle className={styles.dialogTitle}>{resolvedTitle}</DialogTitle>
                <DialogDescription className={styles.dialogDescription} id="terra-settings-description">
                  {resolvedDescription}
                </DialogDescription>
              </div>
              <div className={styles.headerActions}>
                {renderedHeaderSlot}
                <DialogClose className={styles.closeButton} aria-label={t("settings.close")}>
                  <X aria-hidden="true" size={17} strokeWidth={1.8} />
                </DialogClose>
              </div>
            </div>

            {body}
          </DialogContent>
        </DialogPortal>
      </DialogRoot>

      {confirmDialog}
    </>
  );
}
