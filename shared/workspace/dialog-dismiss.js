(function (global) {
  "use strict";
  if (global.OFEnhancerDialogDismiss) return;
  const attached = new WeakSet();

  function childModal(root) {
    for (const frame of root.querySelectorAll("iframe")) {
      if (
        !frame.getBoundingClientRect().width ||
        !frame.getBoundingClientRect().height
      )
        continue;
      try {
        const doc = frame.contentDocument;
        const top = doc?.elementFromPoint(0, 0)?.closest("dialog:modal");
        const modal =
          top || [...(doc?.querySelectorAll("dialog:modal") || [])].at(-1);
        if (modal) return childModal(modal) || modal;
      } catch {
        /* Other origins own their modal behavior. */
      }
    }
    return null;
  }
  function target(event, root) {
    const modal = event.target.closest?.("dialog:modal");
    const nested = childModal(modal || root);
    if (nested) return nested;
    if (!modal || event.target !== modal) return null;
    const rect = modal.getBoundingClientRect();
    return event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
      ? modal
      : null;
  }
  function attach(root) {
    if (attached.has(root)) return;
    attached.add(root);
    let pressed = null,
      released = null;
    root.addEventListener(
      "pointerdown",
      (event) => {
        released = null;
        pressed =
          event.button === 0 && event.isPrimary !== false
            ? { modal: target(event, root), id: event.pointerId }
            : null;
      },
      true,
    );
    root.addEventListener(
      "pointerup",
      (event) => {
        released =
          pressed?.id === event.pointerId &&
          pressed.modal === target(event, root)
            ? pressed.modal
            : null;
        pressed = null;
      },
      true,
    );
    root.addEventListener(
      "pointercancel",
      () => {
        pressed = released = null;
      },
      true,
    );
    root.addEventListener(
      "click",
      (event) => {
        const modal = released;
        released = null;
        if (!modal?.open || modal !== target(event, root)) return;
        event.preventDefault();
        event.stopPropagation();
        // Use Escape's cancel path so uploads and unsaved edits retain their guards.
        if (typeof modal.requestClose === "function") modal.requestClose();
        else {
          const cancel = new global.Event("cancel", { cancelable: true });
          if (modal.dispatchEvent(cancel)) modal.close();
        }
      },
      true,
    );
  }
  global.OFEnhancerDialogDismiss = Object.freeze({ attach });
  if (document.currentScript?.hasAttribute("data-app-dialogs"))
    attach(document);
})(globalThis);
