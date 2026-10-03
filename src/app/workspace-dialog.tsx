"use client";

import { useEffect, useRef, type ReactNode } from "react";

export function WorkspaceDialog({ labelledBy, describedBy, onClose, children }: {
  labelledBy: string;
  describedBy?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const launcher = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    element.showModal();
    document.body.style.overflow = "hidden";
    element.querySelector<HTMLElement>("input, select, textarea")?.focus();
    return () => {
      element.close();
      document.body.style.overflow = previousOverflow;
      if (launcher?.isConnected) launcher.focus({ preventScroll: true });
      else document.getElementById("matches-heading")?.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={dialog} className="modal workspace-dialog" aria-labelledby={labelledBy} aria-describedby={describedBy}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => {
      if (event.key !== "Tab") return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], [tabindex]"))
        .filter(element => element.tabIndex >= 0 && !element.matches(":disabled") && element.getClientRects().length > 0);
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
    }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}>
    {children}
  </dialog>;
}
