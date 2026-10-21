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
  function dismissFramePopovers(event, doc) {
    // Native light dismissal does not cross iframe document boundaries.
    const targets = new Map([[doc, event.target]]);
    let top = doc;
    try {
      while (top.defaultView.frameElement) {
        const frame = top.defaultView.frameElement;
        top = frame.ownerDocument;
        targets.set(top, frame);
      }
    } catch {
      /* Other origins own their menu behavior. */
    }
    function visit(current) {
      if (current !== doc) {
        for (const menu of current.querySelectorAll(
          '[popover="auto"]:popover-open, [popover="hint"]:popover-open',
        )) {
          const target = targets.get(current);
          if (!target || !menu.contains(target)) menu.hidePopover();
        }
      }
      for (const frame of current.querySelectorAll("iframe")) {
        try {
          if (frame.contentDocument) visit(frame.contentDocument);
        } catch {
          /* Other origins own their menu behavior. */
        }
      }
    }
    visit(top);
  }
  function attach(root) {
    if (attached.has(root)) return;
    attached.add(root);
    let pressed = null,
      released = null;
    root.addEventListener(
      "pointerdown",
      (event) => {
        if (root.nodeType === 9 && event.button === 0)
          dismissFramePopovers(event, root);
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
  let confirmationId = 0;
  function confirm({
    title,
    message,
    acceptLabel = "Discard changes",
    cancelLabel = "Keep editing",
  }) {
    const opener = document.activeElement;
    const modal = document.createElement("dialog");
    modal.className = "xt-composer-dialog xt-confirm-dialog";
    modal.setAttribute("role", "alertdialog");
    const id = `xt-confirm-${++confirmationId}`;
    const heading = document.createElement("h2");
    heading.id = `${id}-title`;
    heading.textContent = title;
    const description = document.createElement("p");
    description.id = `${id}-description`;
    description.textContent = message;
    modal.setAttribute("aria-labelledby", heading.id);
    modal.setAttribute("aria-describedby", description.id);
    const form = document.createElement("form");
    form.method = "dialog";
    const actions = document.createElement("footer");
    actions.className = "xt-confirm-actions";
    const cancel = document.createElement("button");
    cancel.type = "submit";
    cancel.className = "xt-action";
    cancel.value = "cancel";
    cancel.textContent = cancelLabel;
    cancel.autofocus = true;
    const accept = document.createElement("button");
    accept.type = "submit";
    accept.className = "xt-action xt-confirm-accept";
    accept.value = "confirm";
    accept.textContent = acceptLabel;
    actions.append(cancel, accept);
    form.append(actions);
    modal.append(heading, description, form);
    // Keep an isolated confirmation dismissible without attaching to other UI.
    attach(modal);
    document.body.append(modal);
    return new Promise((resolve) => {
      modal.addEventListener(
        "close",
        () => {
          const accepted = modal.returnValue === "confirm";
          modal.remove();
          if (opener?.isConnected) opener.focus();
          resolve(accepted);
        },
        { once: true },
      );
      modal.showModal();
      cancel.focus();
    });
  }
  global.OFEnhancerDialogDismiss = Object.freeze({ attach, confirm });
  if (document.currentScript?.hasAttribute("data-app-dialogs"))
    attach(document);
})(globalThis);
