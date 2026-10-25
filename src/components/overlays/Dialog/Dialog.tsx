import { useT } from "../../../i18n";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type ReactNode,
} from "react";

import styles from "./Dialog.module.css";

const cx = (...classes: Array<string | undefined | false>) => classes.filter(Boolean).join(" ");

/**
 * Terra's dialog foundation. Radix owns focus management, inert background,
 * Escape handling, and portal mounting; these wrappers only add the Terra
 * visual language and a small, composable API.
 */
export const DialogRoot = DialogPrimitive.Root;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

export const DialogOverlay = forwardRef<
  ElementRef<typeof DialogPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(function DialogOverlay({ className, ...props }, ref) {
  return <DialogPrimitive.Overlay {...props} ref={ref} className={cx(styles.overlay, className)} />;
});

DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

export const DialogContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(function DialogContent({ className, ...props }, ref) {
  return <DialogPrimitive.Content {...props} ref={ref} className={cx(styles.content, className)} />;
});

DialogContent.displayName = DialogPrimitive.Content.displayName;

export const DialogTitle = forwardRef<
  ElementRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function DialogTitle({ className, ...props }, ref) {
  return <DialogPrimitive.Title {...props} ref={ref} className={cx(styles.title, className)} />;
});

DialogTitle.displayName = DialogPrimitive.Title.displayName;

export const DialogDescription = forwardRef<
  ElementRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function DialogDescription({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Description {...props} ref={ref} className={cx(styles.description, className)} />
  );
});

DialogDescription.displayName = DialogPrimitive.Description.displayName;

export interface DialogHeaderProps {
  children: ReactNode;
  className?: string;
}

function DialogHeader({ children, className }: DialogHeaderProps) {
  return <header className={cx(styles.header, className)}>{children}</header>;
}

export interface DialogFooterProps {
  children: ReactNode;
  className?: string;
}

export function DialogFooter({ children, className }: DialogFooterProps) {
  return <footer className={cx(styles.footer, className)}>{children}</footer>;
}

export interface TerraDialogProps extends Omit<DialogPrimitive.DialogProps, "children"> {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
  titleClassName?: string;
  descriptionClassName?: string;
  shouldShowCloseButton?: boolean;
}

/** A complete dialog for small forms and confirmations. */
export function TerraDialog({
  children,
  className,
  description,
  descriptionClassName,
  footer,
  shouldShowCloseButton = true,
  title,
  titleClassName,
  ...rootProps
}: TerraDialogProps) {
  const translate = useT();
  return (
    <DialogRoot {...rootProps}>
      <DialogPortal>
        <DialogOverlay />
        <DialogContent className={className}>
          <DialogHeader>
            <DialogTitle className={titleClassName}>{title}</DialogTitle>
            {description ? (
              <DialogDescription className={descriptionClassName}>{description}</DialogDescription>
            ) : null}
          </DialogHeader>
          {children}
          {footer ? <DialogFooter>{footer}</DialogFooter> : null}
          {shouldShowCloseButton ? (
            <DialogClose className={styles.closeButton} aria-label={translate("common.close")}>
              <X aria-hidden="true" size={16} strokeWidth={1.8} />
            </DialogClose>
          ) : null}
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  );
}

