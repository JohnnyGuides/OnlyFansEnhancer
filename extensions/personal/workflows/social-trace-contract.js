(() => {
  "use strict";

  if (globalThis.CreatorSocialTraceContract) return;

  const MAX_EVENTS = 800;
  const X_STATUS =
    /^https:\/\/x\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,30})\/?$/;
  const ENTERED_VALUE_KEYS = new Set(["body", "caption", "text", "value"]);
  const SECRET_KEYS = new Set([
    "authorization",
    "cookie",
    "headers",
    "requestbody",
    "responsebody",
  ]);

  function eventControl(event) {
    return event?.data?.control || {};
  }

  function canonicalX(value) {
    try {
      const url = new URL(String(value || ""));
      if (url.search || url.hash || url.username || url.password || url.port) {
        return null;
      }
      const match = url.href.match(X_STATUS);
      return match
        ? {
            handle: match[1],
            id: match[2],
            url: `https://x.com/${match[1]}/status/${match[2]}`,
          }
        : null;
    } catch {
      return null;
    }
  }

  function privateDataFindings(trace) {
    const findings = new Set();
    const walk = (value, key = "") => {
      const normalizedKey = String(key).toLowerCase();
      if (ENTERED_VALUE_KEYS.has(normalizedKey)) findings.add("entered-value");
      if (SECRET_KEYS.has(normalizedKey)) findings.add("header-shaped-secret");
      if (typeof value === "string") {
        if (/(?:^|\s)(?:[A-Za-z]:\\|\/Users\/|\/home\/)/.test(value)) {
          findings.add("local-path");
        }
        if (/\bBearer\s+[A-Za-z0-9._~-]+/i.test(value)) {
          findings.add("header-shaped-secret");
        }
        if (/^data:/i.test(value)) findings.add("data-url");
        if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value)) {
          findings.add("email");
        }
        return;
      }
      if (Array.isArray(value)) {
        for (const child of value) walk(child, key);
        return;
      }
      if (value && typeof value === "object") {
        for (const [childKey, child] of Object.entries(value)) {
          walk(child, childKey);
        }
      }
    };
    walk(trace);
    return [...findings].sort();
  }

  function traceErrors(trace, expectedPlatform) {
    const errors = [];
    if (!trace || typeof trace !== "object" || Array.isArray(trace)) {
      return ["Trace must be an object."];
    }
    if (trace.schemaVersion !== 1) errors.push("Unsupported trace schema.");
    if (trace.platform !== expectedPlatform)
      errors.push("Wrong trace platform.");
    if (trace.active !== false || (!trace.stoppedAt && !trace.stopReason)) {
      errors.push("Trace is still active or incomplete.");
    }
    if (!Array.isArray(trace.events) || trace.events.length === 0) {
      errors.push("Trace has no events.");
    } else if (
      trace.events.length >= MAX_EVENTS ||
      trace.stopReason === "event-cap"
    ) {
      errors.push("Trace reached the event cap.");
    }
    return errors;
  }

  function findIndexAfter(events, start, predicate) {
    for (
      let index = Math.max(0, start + 1);
      index < events.length;
      index += 1
    ) {
      if (predicate(events[index])) return index;
    }
    return -1;
  }

  function findIndexBefore(events, end, predicate) {
    for (let index = 0; index < end; index += 1) {
      if (predicate(events[index])) return index;
    }
    return -1;
  }

  function validateX(trace) {
    const events = trace.events || [];
    const errors = traceErrors(trace, "X");
    const privacy = privateDataFindings(trace);
    if (privacy.length) errors.push("Trace contains private data.");

    const mainSubmit = events.findIndex(
      (event) =>
        event.type === "click" && eventControl(event).testId === "tweetButton",
    );
    if (mainSubmit < 0) errors.push("X main Post control was not recorded.");

    const caption = findIndexBefore(
      events,
      mainSubmit < 0 ? events.length : mainSubmit,
      (event) =>
        event.type === "control-change" &&
        eventControl(event).testId === "tweetTextarea_0" &&
        event.data?.valueState === "nonempty",
    );
    if (caption < 0) errors.push("X caption entry was not recorded.");

    const file = findIndexBefore(
      events,
      mainSubmit < 0 ? events.length : mainSubmit,
      (event) =>
        event.type === "file-selected" &&
        eventControl(event).testId === "fileInput" &&
        event.data?.files?.length === 1 &&
        event.data.files[0]?.type === "video/mp4",
    );
    if (file < 0) errors.push("X social teaser selection was not recorded.");

    const uploadReady = findIndexBefore(
      events,
      mainSubmit < 0 ? events.length : mainSubmit,
      (event) =>
        event.type === "semantic-snapshot" &&
        event.data?.statuses?.some(
          (status) =>
            status.progress === "100" || status.states?.includes("ready"),
        ),
    );
    if (uploadReady < 0)
      errors.push("X upload-ready evidence was not recorded.");

    const mainRouteIndex = findIndexAfter(
      events,
      mainSubmit,
      (event) => event.type === "route" && canonicalX(event.data?.route),
    );
    const main = canonicalX(events[mainRouteIndex]?.data?.route);
    if (!main) errors.push("X canonical main status was not recorded.");

    const replySubmit = findIndexAfter(
      events,
      mainRouteIndex,
      (event) =>
        event.type === "click" &&
        eventControl(event).testId === "tweetButtonInline",
    );
    if (replySubmit < 0)
      errors.push("X first-reply Post control was not recorded.");

    const replyEntry = findIndexAfter(
      events,
      mainRouteIndex,
      (event) =>
        event.type === "control-key" &&
        eventControl(event).testId === "tweetTextarea_0" &&
        event.data?.key === "Enter" &&
        event.ms < (events[replySubmit]?.ms ?? Infinity),
    );
    if (replyEntry < 0)
      errors.push("X paid-link reply entry was not recorded.");

    const previewDismissal = findIndexAfter(events, replyEntry, (event) => {
      const control = eventControl(event);
      return (
        event.type === "click" &&
        control.tag === "button" &&
        control.role === "button" &&
        !control.label &&
        !control.testId &&
        event.ms < (events[replySubmit]?.ms ?? Infinity)
      );
    });
    if (previewDismissal < 0) {
      errors.push("X OnlyFans preview card dismissal was not recorded.");
    }

    const resultSnapshotIndex = findIndexAfter(events, replySubmit, (event) => {
      if (event.type !== "semantic-snapshot" || !main) return false;
      const links = (event.data?.links || []).map(canonicalX).filter(Boolean);
      return links.some(
        (link) => link.handle === main.handle && link.id !== main.id,
      );
    });
    const resultLinks = (events[resultSnapshotIndex]?.data?.links || [])
      .map(canonicalX)
      .filter(Boolean);
    const reply = main
      ? resultLinks.find(
          (link) => link.handle === main.handle && link.id !== main.id,
        )
      : null;
    if (!reply) errors.push("X canonical first reply was not recorded.");

    const deleteConfirmationCount = events.filter(
      (event) =>
        event.type === "click" &&
        eventControl(event).testId === "confirmationSheetConfirm" &&
        eventControl(event).label === "Delete",
    ).length;

    return Object.freeze({
      successfulFlow: errors.length === 0,
      errors: Object.freeze(errors),
      privateDataFindings: Object.freeze(privacy),
      mainResultId: main?.id || "",
      mainResultUrl: main?.url || "",
      replyResultId: reply?.id || "",
      replyResultUrl: reply?.url || "",
      linkPreviewDismissed: previewDismissal >= 0,
      deleteConfirmationCount,
    });
  }

  function validate(trace, expectedPlatform) {
    if (expectedPlatform !== "X") {
      return Object.freeze({
        successfulFlow: false,
        errors: Object.freeze([
          "No validated trace contract for this platform.",
        ]),
        privateDataFindings: Object.freeze(privateDataFindings(trace)),
      });
    }
    return validateX(trace);
  }

  function inspectSchedule(trace) {
    const events = trace?.events || [];
    const menuIndex = events.findIndex(
      (event) => eventControl(event).testId === "scheduleOption",
    );
    const scheduleRoute = findIndexAfter(
      events,
      menuIndex,
      (event) =>
        event.type === "route" &&
        event.data?.route === "https://x.com/compose/post/schedule",
    );
    const confirmIndex = findIndexAfter(
      events,
      scheduleRoute,
      (event) =>
        event.type === "click" &&
        eventControl(event).testId === "scheduledConfirmationPrimaryAction",
    );
    const returnRouteIndex = findIndexAfter(
      events,
      confirmIndex,
      (event) =>
        event.type === "route" &&
        event.data?.route === "https://x.com/compose/post",
    );
    const finalScheduleIndex = findIndexAfter(
      events,
      returnRouteIndex,
      (event) =>
        event.type === "semantic-snapshot" &&
        event.data?.route === "https://x.com/compose/post" &&
        event.data.actions?.some(
          (control) =>
            control.testId === "tweetButton" &&
            String(control.label || "").toLowerCase() === "schedule",
        ),
    );
    const selectEvents = events.filter(
      (event, index) =>
        index > scheduleRoute &&
        index < confirmIndex &&
        event.type === "control-change" &&
        eventControl(event).tag === "select",
    );
    return Object.freeze({
      menuObserved: menuIndex >= 0 && scheduleRoute >= 0,
      confirmed: confirmIndex >= 0 && returnRouteIndex >= 0,
      finalScheduleObserved: finalScheduleIndex >= 0,
      selectChanges: selectEvents.length,
      controlsIdentified: selectEvents.every((event) => {
        const control = eventControl(event);
        return Boolean(control.label || control.name || control.testId);
      }),
      privateDataFindings: Object.freeze(privateDataFindings(trace)),
    });
  }

  globalThis.CreatorSocialTraceContract = Object.freeze({
    inspectSchedule,
    validate,
  });
})();
